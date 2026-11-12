import { describe, expect, it } from 'vitest';

import { startAgentKeyTracker } from '../src/agentKeyTracker.js';
import { agentKey } from '../src/agentMessages.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';

describe('agentKeyTracker', () => {
  it('announces a session change of the same character once, and nothing otherwise', async () => {
    const store = new AgentStateStore();
    const agent = createAgentState({
      id: 1,
      sessionId: 'before-clear',
      projectDir: '/p',
      jsonlFile: '/p/a.jsonl',
      isExternal: true,
    });
    store.set(1, agent);
    const seen: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => {
      if (m.type === 'agentKeyChanged') seen.push(m);
    });
    const tracker = startAgentKeyTracker(store);
    const before = agentKey(agent);

    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    await Promise.resolve();
    expect(seen).toEqual([]);

    // /clear: same character, new session id, then the usual broadcasts.
    agent.sessionId = 'after-clear';
    store.broadcast({ type: 'agentToolsClear', id: 1 });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    await Promise.resolve();
    expect(seen).toEqual([
      { type: 'agentKeyChanged', id: 1, agentKey: agentKey(agent), previousKey: before },
    ]);
    tracker.dispose();
  });
});
