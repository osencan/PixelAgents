/**
 * Restrained ambient decoration: a faint day/night tint over the office that
 * follows the viewer's clock. Purely visual; it never reflects agent activity.
 * On by default, switchable per browser.
 */
import { useSyncExternalStore } from 'react';

import { AMBIENT_NIGHT_TINT, AMBIENT_STORAGE_KEY, AMBIENT_TWILIGHT_TINT } from '../constants.js';

/** The tint for a local hour (0-23), or null in daytime. */
export function ambientTint(hour: number): string | null {
  if (hour >= 21 || hour < 6) return AMBIENT_NIGHT_TINT;
  if (hour >= 18 || hour < 8) return AMBIENT_TWILIGHT_TINT;
  return null;
}

let enabled = (() => {
  try {
    return localStorage.getItem(AMBIENT_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
})();
let version = 0;
const listeners = new Set<() => void>();

export function ambientEnabled(): boolean {
  return enabled;
}

export function setAmbientEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(AMBIENT_STORAGE_KEY, on ? 'on' : 'off');
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

export function useAmbientVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
