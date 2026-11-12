/**
 * Each agent's recent history, as the server keeps it: state changes and
 * failed tools with their time and project label -- metadata only. The
 * server's snapshot (agentHistory) seeds it on connect; live agentLifecycle /
 * agentToolFailed messages extend it.
 */
import type { AgentHistoryEntry } from '../../../core/src/messages.js';
import { AGENT_HISTORY_MAX } from '../constants.js';

export type { AgentHistoryEntry };

const byId = new Map<number, AgentHistoryEntry[]>();

export function setAgentHistory(id: number, entries: AgentHistoryEntry[]): void {
  byId.set(id, entries.slice(-AGENT_HISTORY_MAX));
}

export function appendAgentHistory(id: number, entry: AgentHistoryEntry): void {
  const list = byId.get(id) ?? [];
  list.push(entry);
  if (list.length > AGENT_HISTORY_MAX) list.splice(0, list.length - AGENT_HISTORY_MAX);
  byId.set(id, list);
}

export function getAgentHistory(id: number): readonly AgentHistoryEntry[] {
  return byId.get(id) ?? [];
}

export function clearAgentHistory(id: number): void {
  byId.delete(id);
}
