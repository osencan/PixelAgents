/**
 * Quiet in-office notifications: a confirmed permission request, a finished
 * turn, a failed tool. Only for live events (never a reconnect replay) and
 * only for agents this viewer can see. On by default; switchable per browser.
 */
import { useSyncExternalStore } from 'react';

import { NOTIFICATIONS_STORAGE_KEY, TOAST_DURATION_MS, TOAST_MAX_VISIBLE } from '../constants.js';

export interface Toast {
  key: number;
  agentId: number;
  text: string;
  kind: 'approval' | 'finished' | 'failed';
}

let toasts: Toast[] = [];
let nextKey = 1;
let enabled = loadEnabled();
let version = 0;
const listeners = new Set<() => void>();

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

export function notificationsEnabled(): boolean {
  return enabled;
}

export function setNotificationsEnabled(on: boolean): void {
  enabled = on;
  if (!on) for (const t of [...toasts]) dismissToast(t.key);
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  changed();
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function startTimer(t: Toast): void {
  // A request for approval needs action: it stays until clicked, dismissed or
  // resolved (dismissAgentToasts). The others expire.
  if (t.kind === 'approval') return;
  clearTimeout(timers.get(t.key));
  timers.set(
    t.key,
    setTimeout(() => dismissToast(t.key), TOAST_DURATION_MS),
  );
}

export function pushToast(toast: Omit<Toast, 'key'>): void {
  if (!enabled) return;
  const t = { ...toast, key: nextKey++ };
  const all = [...toasts, t];
  for (const old of all.slice(0, -TOAST_MAX_VISIBLE)) clearTimeout(timers.get(old.key));
  toasts = all.slice(-TOAST_MAX_VISIBLE);
  startTimer(t);
  changed();
}

export function dismissToast(key: number): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const next = toasts.filter((t) => t.key !== key);
  if (next.length === toasts.length) return;
  toasts = next;
  changed();
}

/** Remove an agent's notices of one kind (its approval request was answered). */
export function dismissAgentToasts(agentId: number, kind: Toast['kind']): void {
  for (const t of toasts) if (t.agentId === agentId && t.kind === kind) dismissToast(t.key);
}

/** Hovered or focused: hold the notice until the pointer/focus leaves. */
export function pauseToast(key: number): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
}

export function resumeToast(key: number): void {
  const t = toasts.find((x) => x.key === key);
  if (t) startTimer(t);
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render on any toast or preference change (React side). */
export function useNotificationsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

const ACTIVE_STATES = new Set(['thinking', 'planning', 'reading', 'editing', 'running', 'working']);

/**
 * What a live lifecycle change is worth telling the viewer, if anything. Only
 * reported (observed) states count: a guessed idle is not a finished turn, and
 * only a permission event is a request for approval.
 */
export function lifecycleNotice(
  prev: { lifecycle: string } | undefined,
  next: { lifecycle: string; observed: boolean },
): Toast['kind'] | null {
  if (!next.observed || prev?.lifecycle === next.lifecycle) return null;
  if (next.lifecycle === 'waiting_permission') return 'approval';
  if (
    (next.lifecycle === 'idle' || next.lifecycle === 'waiting_input') &&
    prev !== undefined &&
    (ACTIVE_STATES.has(prev.lifecycle) || prev.lifecycle === 'waiting_permission')
  ) {
    return 'finished';
  }
  return null;
}

export const NOTICE_TEXT: Record<Toast['kind'], string> = {
  approval: 'needs your approval',
  finished: 'finished its turn',
  failed: 'had a tool fail',
};
