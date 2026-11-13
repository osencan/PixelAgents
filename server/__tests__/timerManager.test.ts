import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { PERMISSION_TIMER_DELAY_MS } from '../src/constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from '../src/timerManager.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'test-session',
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundSpawns: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function setup(agent: AgentState) {
  const store = new AgentStateStore();
  store.set(1, agent);
  const sent: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m: Record<string, unknown>) => sent.push(m));
  return { store, sent };
}

const EXEMPT: ReadonlySet<string> = new Set(['Task', 'Agent']);

describe('timerManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the waiting timer marks the agent done (not awaiting input) and can be cancelled', () => {
    const agent = createTestAgent({ turnActive: true });
    const { store, sent } = setup(agent);
    const timers = new Map<number, ReturnType<typeof setTimeout>>();

    startWaitingTimer(1, 1000, store, timers);
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false }]);
    expect(agent.isWaiting).toBe(true);
    expect(agent.turnActive).toBe(false);
    expect(timers.size).toBe(0);

    sent.length = 0;
    startWaitingTimer(1, 1000, store, timers);
    cancelWaitingTimer(1, timers);
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it('restarting the waiting timer replaces the pending one', () => {
    const { store, sent } = setup(createTestAgent());
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    startWaitingTimer(1, 1000, store, timers);
    vi.advanceTimersByTime(800);
    startWaitingTimer(1, 1000, store, timers);
    vi.advanceTimersByTime(800);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(1);
  });

  it('the permission timer only suspects a wait for non-exempt tools, parent or subagent', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const timers = new Map<number, ReturnType<typeof setTimeout>>();

    const exemptOnly = createTestAgent({
      activeToolIds: new Set(['t1']),
      activeToolNames: new Map([['t1', 'Agent']]),
    });
    const a = setup(exemptOnly);
    startPermissionTimer(1, a.store, timers, EXEMPT);
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
    expect(a.sent).toEqual([]);
    expect(exemptOnly.permissionSuspected).toBeFalsy();

    const subBash = createTestAgent({
      activeToolIds: new Set(['t1']),
      activeToolNames: new Map([['t1', 'Agent']]),
      activeSubagentToolNames: new Map([['t1', new Map([['s1', 'Bash']])]]),
    });
    const b = setup(subBash);
    startPermissionTimer(1, b.store, timers, EXEMPT);
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
    // A guess, never a permission request.
    expect(b.sent).toEqual([{ type: 'agentPermissionSuspected', id: 1 }]);
    expect(subBash.permissionSuspected).toBe(true);
    expect(subBash.permissionSent).toBe(false);

    const c = setup(
      createTestAgent({
        activeToolIds: new Set(['t1']),
        activeToolNames: new Map([['t1', 'Bash']]),
      }),
    );
    startPermissionTimer(1, c.store, timers, EXEMPT);
    cancelPermissionTimer(1, timers);
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
    expect(c.sent).toEqual([]);
  });

  it('clearing activity keeps background spawns and re-sends them as subagent tools', () => {
    const agent = createTestAgent({
      isWaiting: true,
      permissionSent: true,
      permissionSuspected: true,
      activeToolIds: new Set(['fg', 'bg']),
      activeToolStatuses: new Map([
        ['fg', 'Running: ls'],
        ['bg', 'Subtask: research'],
      ]),
      activeToolNames: new Map([
        ['fg', 'Bash'],
        ['bg', 'Agent'],
      ]),
      backgroundSpawns: new Map([['bg', {}]]) as AgentState['backgroundSpawns'],
    });
    const { store, sent } = setup(agent);
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    startPermissionTimer(1, store, permissionTimers, EXEMPT);

    clearAgentActivity(agent, 1, store, permissionTimers);

    expect([...agent.activeToolIds]).toEqual(['bg']);
    expect(agent.isWaiting).toBe(false);
    expect(agent.turnActive).toBe(true);
    expect(agent.permissionSent).toBe(false);
    expect(agent.permissionSuspected).toBe(false);
    expect(permissionTimers.size).toBe(0);
    expect(sent.map((m) => m.type)).toEqual(['agentToolsClear', 'agentToolStart', 'agentStatus']);
    expect(sent[1]).toMatchObject({
      toolId: 'bg',
      status: 'Subtask: research',
      toolName: 'Agent',
      runInBackground: true,
    });
    expect(sent[2]).toEqual({ type: 'agentStatus', id: 1, status: 'active' });
  });

  it('clearing activity with no background spawns empties every tool map; unknown agents are ignored', () => {
    const agent = createTestAgent({
      activeToolIds: new Set(['fg']),
      activeToolStatuses: new Map([['fg', 'Running: ls']]),
      activeToolNames: new Map([['fg', 'Bash']]),
    });
    const { store, sent } = setup(agent);
    clearAgentActivity(agent, 1, store, new Map());
    expect(agent.activeToolIds.size).toBe(0);
    expect(agent.activeToolStatuses.size).toBe(0);
    expect(sent.map((m) => m.type)).toEqual(['agentToolsClear', 'agentStatus']);

    sent.length = 0;
    clearAgentActivity(undefined, 2, store, new Map());
    expect(sent).toEqual([]);
  });
});
