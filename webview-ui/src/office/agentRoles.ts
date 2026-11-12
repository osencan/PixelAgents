/**
 * Roles the viewer assigns to agents (builder, reviewer, ...), shown as a
 * badge. Nothing reports roles, so they are the viewer's labels: per browser,
 * keyed by the stable agentKey so they survive reloads and server restarts.
 */
import { useSyncExternalStore } from 'react';

import { AGENT_ROLE_MAX_LENGTH, AGENT_ROLES_STORAGE_KEY } from '../constants.js';
import { getAgentKey } from './hiddenAgents.js';

let roles: Record<string, string> = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(AGENT_ROLES_STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function getAgentRole(id: number): string | undefined {
  const key = getAgentKey(id);
  return key ? roles[key] : undefined;
}

/** Set (or with an empty value, clear) an agent's role. */
export function setAgentRole(id: number, role: string): void {
  const key = getAgentKey(id);
  if (!key) return;
  const value = role.trim().slice(0, AGENT_ROLE_MAX_LENGTH);
  const next = { ...roles };
  if (value) next[key] = value;
  else delete next[key];
  roles = next;
  try {
    localStorage.setItem(AGENT_ROLES_STORAGE_KEY, JSON.stringify(roles));
  } catch {
    // Storage unavailable: the role lasts for this page only.
  }
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentRolesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
