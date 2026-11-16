/**
 * The activity history on disk (~/.pixel-agents/history.json), so a restart
 * keeps the last day: entries per agentKey (a stable opaque session key, never
 * a path or prompt), each metadata only. Bounded twice: entries older than 24
 * hours are dropped, and the oldest quarter goes until the file fits in 200 KB.
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import * as fs from 'node:fs';

import type { AgentHistoryEntry } from './agentLifecycle.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';

export const HISTORY_MAX_AGE_MS = 24 * 60 * 60_000;
export const HISTORY_MAX_BYTES = 200 * 1024;

export type HistoryByKey = Map<string, AgentHistoryEntry[]>;

function isEntry(e: unknown): e is AgentHistoryEntry {
  const r = e as Record<string, unknown> | null;
  return (
    !!r &&
    typeof r.at === 'number' &&
    (r.kind === 'state' || r.kind === 'tool_failed' || r.kind === 'check')
  );
}

export function readHistoryFile(file: string, now = Date.now()): HistoryByKey {
  const out: HistoryByKey = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents?: unknown };
    if (!raw.agents || typeof raw.agents !== 'object') return out;
    for (const [key, list] of Object.entries(raw.agents as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => isEntry(e) && now - e.at <= HISTORY_MAX_AGE_MS);
      if (kept.length) out.set(key, kept as AgentHistoryEntry[]);
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return out;
}

/** What goes to disk: recent entries only, trimmed oldest-first to the size cap. */
export function boundHistory(
  history: HistoryByKey,
  now = Date.now(),
): Record<string, AgentHistoryEntry[]> {
  let all: Array<[string, AgentHistoryEntry]> = [];
  for (const [key, list] of history) {
    for (const e of list) if (now - e.at <= HISTORY_MAX_AGE_MS) all.push([key, e]);
  }
  all.sort((a, b) => a[1].at - b[1].at);
  const build = () => {
    const agents: Record<string, AgentHistoryEntry[]> = {};
    for (const [key, e] of all) (agents[key] ??= []).push(e);
    return agents;
  };
  let agents = build();
  while (all.length && JSON.stringify({ version: 1, agents }).length > HISTORY_MAX_BYTES) {
    all = all.slice(Math.max(1, Math.floor(all.length / 4)));
    agents = build();
  }
  return agents;
}

export function writeHistoryFile(file: string, history: HistoryByKey, now = Date.now()): void {
  try {
    writeJsonAtomic(file, { version: 1, agents: boundHistory(history, now) });
  } catch {
    // History is a convenience: a failed write only loses it on the next restart.
  }
}
