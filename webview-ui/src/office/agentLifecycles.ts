/**
 * The server's explicit lifecycle per agent (agentLifecycle messages): one
 * state, whether a provider reported it or it was inferred, and when it began.
 * Read by the label over each character and by the detail panel.
 */
import type { AgentLifecycleState } from '../../../core/src/messages.js';

export interface AgentLifecycleInfo {
  lifecycle: AgentLifecycleState;
  observed: boolean;
  permissionSuspected: boolean;
  since: number;
}

const byId = new Map<number, AgentLifecycleInfo>();

export function setAgentLifecycle(id: number, info: AgentLifecycleInfo): void {
  byId.set(id, info);
}

export function clearAgentLifecycle(id: number): void {
  byId.delete(id);
}

export function getAgentLifecycle(id: number): AgentLifecycleInfo | undefined {
  return byId.get(id);
}

const LIFECYCLE_TEXT: Record<AgentLifecycleState, string> = {
  thinking: 'Thinking',
  reading: 'Reading',
  editing: 'Editing',
  running: 'Running',
  working: 'Working',
  waiting_permission: 'Needs approval',
  waiting_input: 'Waiting for input',
  idle: 'Idle',
  unknown: 'No recent activity',
};

export function lifecycleText(state: AgentLifecycleState): string {
  return LIFECYCLE_TEXT[state];
}
