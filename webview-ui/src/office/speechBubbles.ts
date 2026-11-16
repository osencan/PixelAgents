/**
 * What a character says over its head, in priority order. A request for
 * approval keeps its own beacon (ToolOverlay); after it come:
 *
 * 1. "Stuck?": working, but quiet past this viewer's threshold (a guess).
 * 2. The first line of its reply, for a while after a turn ends. Only tokened
 *    pages have reply text (agentWorkItems); a read-only page keeps the
 *    plain "done" bubble.
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import type { AgentLifecycleState } from '../../../core/src/messages.js';
import { SPEECH_REPLY_MAX_CHARS, SPEECH_REPLY_MS } from '../constants.js';
import { quietState } from './stuckAgents.js';

const finishedAt = new Map<number, number>();

/** A turn just ended (a live, reported finish). */
export function noteTurnFinished(id: number, at = Date.now()): void {
  finishedAt.set(id, at);
}

/** Work resumed or the agent left: its last reply is old news. */
export function clearSpeech(id: number): void {
  finishedAt.delete(id);
}

/** Clip by characters, not UTF-16 units, so an emoji is never cut in half. */
export function clipSpeech(text: string, max = SPEECH_REPLY_MAX_CHARS): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

export type Speech = { kind: 'stuck'; text: string } | { kind: 'reply'; text: string };

export function speechFor(
  id: number,
  life: { lifecycle: AgentLifecycleState; observed: boolean; since: number } | undefined,
  reply: string | undefined,
  now: number,
): Speech | null {
  const quiet = quietState(id, life, now);
  if (quiet?.kind === 'stuck') return { kind: 'stuck', text: 'Stuck?' };
  const at = finishedAt.get(id);
  if (at !== undefined && now - at < SPEECH_REPLY_MS && reply) {
    return { kind: 'reply', text: clipSpeech(reply) };
  }
  return null;
}
