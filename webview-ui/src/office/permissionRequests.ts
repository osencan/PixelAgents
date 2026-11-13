/**
 * Permission requests the office may answer right now (agentPermissionPending
 * until agentPermissionResolved), each tracked by its request id. Only control
 * clients can answer, and an answer always names the request it was shown;
 * the terminal prompt stays usable in parallel and wins if answered first.
 */
import { useSyncExternalStore } from 'react';

import { transport } from '../transport/index.js';

export interface PendingPermission {
  requestId: string;
  agentId: number;
  toolName: string;
  /** Short status line (a category only on read-only pages). */
  status: string;
  /** The full request; only connections that may answer receive it. */
  detail?: string;
  /** False when too long to show in full: it can only be denied here. */
  complete: boolean;
  expiresAt: number;
  /** An answer from this page is on its way. */
  sent?: 'allow' | 'deny';
}

const byRequest = new Map<string, PendingPermission>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

export function setPendingPermission(p: PendingPermission): void {
  byRequest.set(p.requestId, p);
  changed();
}

export function clearPendingPermission(requestId: string): void {
  if (byRequest.delete(requestId)) changed();
}

/** Forget a closed agent's requests. */
export function clearAgentPermissions(agentId: number): void {
  let any = false;
  for (const [id, p] of byRequest) if (p.agentId === agentId) any = byRequest.delete(id) || any;
  if (any) changed();
}

/** The agent's oldest open request (the one its prompt is showing). */
export function getPendingPermission(agentId: number): PendingPermission | undefined {
  for (const p of byRequest.values()) if (p.agentId === agentId) return p;
  return undefined;
}

/** Answer exactly the request that was displayed; a newer one is never answered by it. */
export function answerPermission(requestId: string, behavior: 'allow' | 'deny'): void {
  const p = byRequest.get(requestId);
  if (!p || p.sent) return;
  if (behavior === 'allow' && !p.complete) return;
  byRequest.set(requestId, { ...p, sent: behavior });
  transport.send({ type: 'approvePermission', requestId, behavior });
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePermissionsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
