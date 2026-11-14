import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * The character shown for a /subtask fork, found from a hook event's fork id
 * (`forkIdOfHookEvent`). A fork's transcript is `subagents/agent-<id>.jsonl`
 * under its lead's session, so the id names it exactly. Undefined when forks
 * aren't shown (Settings → Show Subtasks as Agents) or this one isn't adopted.
 */
export function findForkAgent(
  agents: AgentStateStore,
  sessionId: string,
  forkId: string,
): [number, AgentState] | undefined {
  const file = `agent-${forkId}.jsonl`;
  return [...agents].find(
    ([, a]) =>
      a.isFork === true && a.sessionId === sessionId && path.basename(a.jsonlFile) === file,
  );
}
