/**
 * Per-project presentation: a stable accent color derived from the project's
 * name, and (per browser) the desk the project last used, so a project's new
 * sessions return to "its" desk when it is free.
 */
import { PROJECT_ACCENT_COLORS, PROJECT_SEATS_STORAGE_KEY } from '../constants.js';
import { projectOfLabel } from './agentFilter.js';

/** Stable accent for a character label's project (FNV-1a over the name). */
export function projectAccent(directoryName: string | undefined): string {
  const name = projectOfLabel(directoryName);
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PROJECT_ACCENT_COLORS[(hash >>> 0) % PROJECT_ACCENT_COLORS.length];
}

let seats: Record<string, string> = load();

function load(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROJECT_SEATS_STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** The desk this label's project last used, if any. */
export function rememberedSeat(directoryName: string | undefined): string | undefined {
  return directoryName ? seats[projectOfLabel(directoryName)] : undefined;
}

export function rememberSeat(directoryName: string | undefined, seatId: string): void {
  if (!directoryName) return;
  const project = projectOfLabel(directoryName);
  if (seats[project] === seatId) return;
  seats = { ...seats, [project]: seatId };
  try {
    localStorage.setItem(PROJECT_SEATS_STORAGE_KEY, JSON.stringify(seats));
  } catch {
    // Storage unavailable: remembered for this page only.
  }
}
