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
  /** Devices unlocked with the PIN may add and edit Directories (host's choice). */
  remoteDirectories: boolean;
  ticket?: string;
  error?: 'wrong' | 'locked' | 'no-pin';
  lockedUntil?: number;
}

let access: ControlAccess = {
  control: false,
  local: false,
  pinSet: false,
  remoteDirectories: false,
};
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

/** This browser may add and edit Directories: the host's own, or an unlocked
 *  device the host allowed. The server decides; this only keeps the UI honest. */
export function canEditDirectories(a: ControlAccess = access): boolean {
  return a.local || (a.control && a.remoteDirectories);
}

/** This browser may delete Directories: the host, or any device unlocked with
 *  the PIN (deleting only narrows where agents can be launched). */
export function canDeleteDirectories(a: ControlAccess = access): boolean {
  return a.local || a.control;
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
