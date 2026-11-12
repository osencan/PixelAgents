/**
 * Agents this viewer hid from the office. Hiding is a per-browser view choice,
 * not a removal: the session stays tracked, keeps its seat and its card (drawn
 * faded), and unhiding brings the character straight back. Keyed by the
 * server's stable agentKey, so a hide survives reloads and server restarts
 * (numeric ids are reused across restarts).
 */

import { useSyncExternalStore } from 'react';

import { HIDDEN_AGENTS_STORAGE_KEY } from '../constants.js';

const keyById = new Map<number, string>();
let hiddenKeys = loadHiddenKeys();
const listeners = new Set<() => void>();
// Bumped on every change so useSyncExternalStore snapshots compare cheaply.
let version = 0;

function loadHiddenKeys(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HIDDEN_AGENTS_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Record an agent's key (agentCreated / existingAgents). */
export function setAgentKey(id: number, key: string | undefined): void {
  if (!key || keyById.get(id) === key) return;
  keyById.set(id, key);
  changed();
}

/** Forget a closed agent's id (the key's hidden state is kept for its return). */
export function clearAgentKey(id: number): void {
  if (keyById.delete(id)) changed();
}

export function isAgentHidden(id: number): boolean {
  const key = keyById.get(id);
  return key !== undefined && hiddenKeys.has(key);
}

export function setAgentHidden(id: number, hidden: boolean): void {
  const key = keyById.get(id);
  if (key === undefined || hiddenKeys.has(key) === hidden) return;
  hiddenKeys = new Set(hiddenKeys);
  if (hidden) hiddenKeys.add(key);
  else hiddenKeys.delete(key);
  try {
    localStorage.setItem(HIDDEN_AGENTS_STORAGE_KEY, JSON.stringify([...hiddenKeys]));
  } catch {
    // Storage unavailable (private window): the hide lasts for this page only.
  }
  changed();
}

/** Ids of the agents currently hidden. */
export function hiddenAgentIds(): number[] {
  return [...keyById].filter(([, key]) => hiddenKeys.has(key)).map(([id]) => id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render on any hide/unhide (React side). */
export function useHiddenAgentsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function useIsAgentHidden(id: number): boolean {
  useHiddenAgentsVersion();
  return isAgentHidden(id);
}
