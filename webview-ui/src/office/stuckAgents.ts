/**
 * Agents that went quiet: a guess, never a report.
 *
 * - "Stuck?": the agent is working, but nothing has arrived about it (no tool
 *   step, no state change, no context reading) for N minutes. A slow build is
 *   quiet too, so this is a question, not a verdict.
 * - "Still needs you": a reported approval request has waited N minutes.
 *
 * Each quiet spell notifies once. N is this viewer's choice (Settings, This
 * browser only); off turns both off. Also here: when the current turn began,
 * so "finished its turn" can stay quiet for short turns if the viewer asks.
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import { useSyncExternalStore } from 'react';

import type { AgentLifecycleState } from '../../../core/src/messages.js';
import { LONG_TURN_MS, STUCK_MINUTES_DEFAULT, STUCK_STORAGE_KEY } from '../constants.js';

const ACTIVE: ReadonlySet<AgentLifecycleState> = new Set([
  'thinking',
  'planning',
  'reading',
  'editing',
  'running',
  'working',
]);

interface Prefs {
  minutes: number;
  longTurnsOnly: boolean;
}

let prefs: Prefs = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STUCK_STORAGE_KEY) ?? 'null') as Partial<Prefs>;
    return {
      minutes: typeof raw?.minutes === 'number' ? raw.minutes : STUCK_MINUTES_DEFAULT,
      longTurnsOnly: raw?.longTurnsOnly === true,
    };
  } catch {
    return { minutes: STUCK_MINUTES_DEFAULT, longTurnsOnly: false };
  }
})();
let version = 0;
const listeners = new Set<() => void>();

function save(next: Prefs): void {
  prefs = next;
  try {
    localStorage.setItem(STUCK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  version += 1;
  for (const l of listeners) l();
}

export function stuckMinutes(): number {
  return prefs.minutes;
}

export function setStuckMinutes(minutes: number): void {
  save({ ...prefs, minutes });
}

export function longTurnsOnly(): boolean {
  return prefs.longTurnsOnly;
}

export function setLongTurnsOnly(on: boolean): void {
  save({ ...prefs, longTurnsOnly: on });
}

export function useStuckPrefsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** Last time anything arrived about each agent, and when its turn began. */
const lastNews = new Map<number, number>();
const turnStart = new Map<number, number>();
/** The spell (its start time) each agent was last notified for. */
const notified = new Map<number, string>();

/** Something arrived about this agent: it isn't quiet. */
export function noteAgentNews(id: number, at = Date.now()): void {
  lastNews.set(id, at);
}

/** Track turn starts from lifecycle changes (live or replayed). */
export function noteAgentLifecycle(
  id: number,
  prev: AgentLifecycleState | undefined,
  next: AgentLifecycleState,
  since: number,
): void {
  if (ACTIVE.has(next) && (!prev || !ACTIVE.has(prev)) && next !== 'waiting_permission') {
    turnStart.set(id, since);
  }
}

/** A turn that just ended (at `endedAt`): was it long enough to announce? */
export function turnWorthAnnouncing(id: number, endedAt: number): boolean {
  if (!prefs.longTurnsOnly) return true;
  const start = turnStart.get(id);
  // Unknown start (page opened mid-turn): announce rather than miss a long one.
  return start === undefined || endedAt - start >= LONG_TURN_MS;
}

export function forgetAgent(id: number): void {
  lastNews.delete(id);
  turnStart.delete(id);
  notified.delete(id);
}

export type QuietKind = 'stuck' | 'needs_you';

export interface Quiet {
  kind: QuietKind;
  /** When the quiet spell began. */
  since: number;
}

/** Whether this agent has gone quiet, by this viewer's threshold. */
export function quietState(
  id: number,
  life: { lifecycle: AgentLifecycleState; observed: boolean; since: number } | undefined,
  now: number,
): Quiet | null {
  if (!life || prefs.minutes <= 0) return null;
  const limit = prefs.minutes * 60_000;
  if (life.lifecycle === 'waiting_permission' && life.observed) {
    return now - life.since >= limit ? { kind: 'needs_you', since: life.since } : null;
  }
  if (!ACTIVE.has(life.lifecycle)) return null;
  // First seen on this page counts as news: a reload never makes everyone "stuck".
  const news = Math.max(lastNews.get(id) ?? now, life.since);
  if (!lastNews.has(id)) lastNews.set(id, now);
  return now - news >= limit ? { kind: 'stuck', since: news } : null;
}

/** True once per quiet spell: the caller notifies. */
export function shouldNotifyQuiet(id: number, quiet: Quiet): boolean {
  const key = `${quiet.kind}:${quiet.since}`;
  if (notified.get(id) === key) return false;
  notified.set(id, key);
  return true;
}

export function quietText(q: Quiet, now: number): string {
  const minutes = Math.max(1, Math.round((now - q.since) / 60_000));
  return q.kind === 'needs_you'
    ? `Still needs you (${minutes}m)`
    : `Stuck? No news for ${minutes}m`;
}
