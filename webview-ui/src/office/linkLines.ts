/**
 * Whether this viewer sees the dashed lines from a selected agent to its
 * lead/parent and its subagents. On by default, switchable per browser.
 */
import { useSyncExternalStore } from 'react';

import { LINK_LINES_STORAGE_KEY } from '../constants.js';

let enabled = (() => {
  try {
    return localStorage.getItem(LINK_LINES_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
})();
let version = 0;
const listeners = new Set<() => void>();

export function linkLinesEnabled(): boolean {
  return enabled;
}

export function setLinkLinesEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(LINK_LINES_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLinkLinesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
