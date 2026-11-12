import * as crypto from 'crypto';

import type { AgentState } from './types.js';

/** Hex digits of the session hash kept in an agent key. */
const AGENT_KEY_HASH_LENGTH = 16;

/**
 * A stable, opaque key for an agent's session: unlike the numeric id it
 * survives server restarts, and unlike the raw session id it reveals nothing
 * to read-only viewers. Viewers key per-browser preferences (hidden agents) on it.
 */
export function agentKey(agent: Pick<AgentState, 'sessionId' | 'providerId'>): string {
  const hash = crypto.createHash('sha256').update(agent.sessionId).digest('hex');
  return `${agent.providerId ?? 'claude'}:${hash.slice(0, AGENT_KEY_HASH_LENGTH)}`;
}

/**
 * The `agentCreated` message announcing an agent to the office: one builder
 * for both surfaces, so a field added here reaches both. `seatId` is the seat
 * a resumed agent asks for (only the standalone launcher sets it).
 */
export function agentCreatedMessage(id: number, agent: AgentState): Record<string, unknown> {
  return {
    type: 'agentCreated',
    id,
    agentKey: agentKey(agent),
    directoryName: agent.directoryName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    repeat: agent.repeat,
    seatId: agent.seatId,
  };
}
