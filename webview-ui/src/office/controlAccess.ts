/**
 * This connection's control state, as the server reports it (controlAccess):
 * whether agents may be controlled from here, whether we are on the server's
 * own machine, whether a control PIN exists, and the last unlock error. Also
 * which agents' projects accept browser approvals (approvalOptIns).
 */
import { useSyncExternalStore } from 'react';

export interface ControlAccess {
  control: boolean;
  local: boolean;
  pinSet: boolean;
  ticket?: string;
  error?: 'wrong' | 'locked' | 'no-pin';
  lockedUntil?: number;
}

let access: ControlAccess = { control: false, local: false, pinSet: false };
let optedIn = new Set<number>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

export function setControlAccess(next: ControlAccess): void {
  access = next;
  changed();
}

export function getControlAccess(): ControlAccess {
  return access;
}

export function setPinSet(pinSet: boolean): void {
  access = { ...access, pinSet };
  changed();
}

export function setApprovalOptIns(ids: number[]): void {
  optedIn = new Set(ids);
  changed();
}

export function isApprovalOptedIn(id: number): boolean {
  return optedIn.has(id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useControlVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
