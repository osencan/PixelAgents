import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveLifecycle,
  LIFECYCLE_STALE_AFTER_MS,
  sendLifecycleSnapshot,
  startAgentLifecycle,
} from '../src/agentLifecycle.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';

function agent(overrides: Partial<ReturnType<typeof createAgentState>> = {}) {
  const a = createAgentState({
    id: 1,
    sessionId: 's1',
    projectDir: '/p',
    jsonlFile: '/p/s1.jsonl',
    isExternal: true,
  });
  a.hookDelivered = true;
  a.lastDataAt = Date.now();
  return Object.assign(a, overrides);
}

function withTool(a: ReturnType<typeof agent>, name: string, status = name) {
  a.turnActive = true;
  a.activeToolIds.add('t1');
  a.activeToolNames.set('t1', name);
  a.activeToolStatuses.set('t1', status);
  return a;
}

afterEach(() => vi.useRealTimers());

describe('deriveLifecycle', () => {
  it('maps the running tool to a category, reported by hooks', () => {
    expect(deriveLifecycle(withTool(agent(), 'Read'))).toMatchObject({
      lifecycle: 'reading',
      observed: true,
    });
    expect(deriveLifecycle(withTool(agent(), 'Edit')).lifecycle).toBe('editing');
    expect(deriveLifecycle(withTool(agent(), 'Bash')).lifecycle).toBe('running');
    expect(deriveLifecycle(withTool(agent(), 'mcp__x__y')).lifecycle).toBe('working');
    expect(deriveLifecycle(agent({ turnActive: true })).lifecycle).toBe('thinking');
  });

  it('only a permission event means waiting_permission; the timer is a suspicion', () => {
    const slowBuild = withTool(agent(), 'Bash');
    slowBuild.permissionSuspected = true;
    expect(deriveLifecycle(slowBuild)).toEqual({
      lifecycle: 'running',
      observed: true,
      permissionSuspected: true,
    });
    slowBuild.permissionSent = true;
    expect(deriveLifecycle(slowBuild)).toMatchObject({
      lifecycle: 'waiting_permission',
      observed: true,
    });
  });

  it('a long command stays running; mid-turn silence without a tool is unknown, not asleep', () => {
    const now = Date.now();
    const longCommand = withTool(agent({ lastDataAt: now - 2 * LIFECYCLE_STALE_AFTER_MS }), 'Bash');
    expect(deriveLifecycle(longCommand, now).lifecycle).toBe('running');
    const silent = agent({ turnActive: true, lastDataAt: now - 2 * LIFECYCLE_STALE_AFTER_MS });
    expect(deriveLifecycle(silent, now)).toMatchObject({ lifecycle: 'unknown', observed: false });
  });

  it('distinguishes finished turns from waiting on the user, and flags transcript-only as inferred', () => {
    expect(deriveLifecycle(agent()).lifecycle).toBe('idle');
    expect(deriveLifecycle(agent({ awaitingInput: true })).lifecycle).toBe('waiting_input');
    expect(deriveLifecycle(withTool(agent({ hookDelivered: false }), 'Read')).observed).toBe(false);
  });

  it('reads Codex categories from its status text', () => {
    const codex = withTool(agent({ providerId: 'codex' }), 'Edit', 'Codex: running a command');
    expect(deriveLifecycle(codex).lifecycle).toBe('running');
  });
});

describe('startAgentLifecycle', () => {
  it('broadcasts changes once per batch, keeps `since` while unchanged, and replays on reconnect', async () => {
    const store = new AgentStateStore();
    const a = agent();
    store.set(1, a);
    const seen: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => {
      if (m.type === 'agentLifecycle') seen.push(m);
    });
    const service = startAgentLifecycle(store);
    await Promise.resolve();
    expect(seen.at(-1)).toMatchObject({ id: 1, lifecycle: 'idle' });

    withTool(a, 'Bash');
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    store.broadcast({
      type: 'agentToolStart',
      id: 1,
      toolId: 't1',
      status: 'Running',
      toolName: 'Bash',
    });
    await Promise.resolve();
    expect(seen.filter((m) => m.lifecycle === 'running')).toHaveLength(1);

    const replay: Array<Record<string, unknown>> = [];
    sendLifecycleSnapshot(store, (m) => replay.push(m));
    expect(replay).toEqual([seen.at(-1)]);
    service.dispose();
  });
});
