import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  CodexOfficeBridge,
  CodexTail,
  emptyCodexSession,
  reduceCodexRecord,
} from '../src/codexSessions.js';
vi.mock('../src/paletteAssigner.js', () => ({ assignPaletteIfNeeded: () => {} }));
const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const record = (type: string, payload: object, at = Date.now()) => ({
  timestamp: new Date(at).toISOString(),
  type,
  payload,
});
function session() {
  const s = emptyCodexSession();
  reduceCodexRecord(
    s,
    record('session_meta', { id: 'test-session', cwd: '/projects/ApiServer' }),
  );
  reduceCodexRecord(s, record('event_msg', { type: 'task_started' }));
  return s;
}
describe('Codex lifecycle normalization', () => {
  test('tools complete without marking a continuing turn idle; task_complete does', () => {
    const s = session();
    reduceCodexRecord(
      s,
      record('response_item', {
        type: 'function_call',
        name: 'read_file',
        call_id: 'a',
        arguments: 'PRIVATE',
      }),
    );
    expect(s.reading).toBe(true);
    reduceCodexRecord(
      s,
      record('response_item', { type: 'function_call_output', call_id: 'a', output: 'PRIVATE' }),
    );
    expect(s.phase).toBe('active');
    expect(s.activity).toBe('Codex: working');
    reduceCodexRecord(
      s,
      record('event_msg', { type: 'task_complete', last_agent_message: 'PRIVATE' }),
    );
    expect(s.phase).toBe('idle');
    expect(s.tools.size).toBe(0);
    expect(JSON.stringify(s)).not.toContain('PRIVATE');
  });
  test('custom tools and aborted/resumed turns are supported', () => {
    const s = session();
    reduceCodexRecord(
      s,
      record('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b' }),
    );
    expect(s.activity).toBe('Codex: editing');
    reduceCodexRecord(s, record('event_msg', { type: 'turn_aborted' }));
    expect(s.phase).toBe('idle');
    reduceCodexRecord(s, record('event_msg', { type: 'task_started' }));
    expect(s.phase).toBe('active');
  });
  test('parallel tool completion retains the remaining activity', () => {
    const s = session();
    reduceCodexRecord(
      s,
      record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'a' }),
    );
    reduceCodexRecord(
      s,
      record('response_item', { type: 'function_call', name: 'read_file', call_id: 'b' }),
    );
    reduceCodexRecord(s, record('response_item', { type: 'function_call_output', call_id: 'b' }));
    expect(s.activity).toBe('Codex: running a command');
    expect(s.phase).toBe('active');
  });
});

describe('incremental rollout reading', () => {
  test('partial lines and UTF-8 writes are buffered, not lost or replayed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-codex-test-'));
    temps.push(dir);
    const file = path.join(dir, 'rollout.jsonl');
    const meta = Buffer.from(
      JSON.stringify(record('session_meta', { id: 'one', cwd: '/projects/İstanbul' })) + '\n',
    );
    const split = meta.indexOf(Buffer.from('İ')) + 1;
    await fs.writeFile(file, meta.subarray(0, split));
    const tail = new CodexTail();
    await tail.read(file);
    expect(tail.session.id).toBe('');
    await fs.appendFile(file, meta.subarray(split));
    await fs.appendFile(file, JSON.stringify(record('event_msg', { type: 'task_started' })) + '\n');
    await tail.read(file);
    expect(tail.session.cwd).toBe('/projects/İstanbul');
    expect(tail.session.phase).toBe('active');
    const offset = tail.offset;
    await tail.read(file);
    expect(tail.offset).toBe(offset);
    await fs.appendFile(
      file,
      'bad json\n' + JSON.stringify(record('event_msg', { type: 'task_complete' })) + '\n',
    );
    await tail.read(file);
    expect(tail.session.phase).toBe('idle');
    await fs.writeFile(
      file,
      JSON.stringify(record('session_meta', { id: 'two', cwd: '/new' })) + '\n',
    );
    await tail.read(file);
    expect(tail.session.id).toBe('two');
    expect(tail.session.seenTurn).toBe(false);
  });
});

describe('office integration', () => {
  test('creates distinct Codex labels and sends active/idle events without touching Claude', () => {
    const store = new AgentStateStore();
    store.set(
      99,
      createAgentState({
        id: 99,
        sessionId: 'claude-existing',
        jsonlFile: '',
        projectDir: '/claude',
        isExternal: true,
      }),
    );
    const messages: unknown[] = [];
    store.on('broadcast', (m) => messages.push(m));
    const bridge = new CodexOfficeBridge(store);
    const s = session();
    bridge.sync(s);
    const agent = [...store.values()].find((a) => a.providerId === 'codex')!;
    expect(agent.directoryName).toBe('Codex · ApiServer');
    expect(agent.turnActive).toBe(true);
    expect(toPersistedAgent(agent)).toBeNull();
    reduceCodexRecord(s, record('event_msg', { type: 'task_complete' }));
    bridge.sync(s);
    expect(agent.isWaiting).toBe(true);
    expect(agent.activeToolIds.size).toBe(0);
    expect(messages).toContainEqual({
      type: 'agentStatus',
      id: agent.id,
      status: 'waiting',
      awaitingInput: false,
    });
    bridge.dispose();
    expect(store.size).toBe(1);
    expect(store.has(99)).toBe(true);
  });
  test('does not resurrect old sessions and expires silent tracked sessions', () => {
    const store = new AgentStateStore();
    const bridge = new CodexOfficeBridge(store);
    const s = session();
    bridge.sync(s, s.updated + 6 * 60_000);
    expect(store.size).toBe(0);
    bridge.sync(s, s.updated);
    expect(store.size).toBe(1);
    bridge.sync(s, s.updated + 31 * 60_000);
    expect(store.size).toBe(0);
  });
  test('a subagent session gets its own labelled character', () => {
    const store = new AgentStateStore();
    const bridge = new CodexOfficeBridge(store);
    const s = session();
    s.parent = 'parent';
    bridge.sync(s);
    expect([...store.values()][0].directoryName).toContain('subagent');
    // No parent in the office: no link is invented.
    expect([...store.values()][0].leadAgentId).toBeUndefined();
  });
  test('a subagent links to its parent only when the parent session is in the office', () => {
    const store = new AgentStateStore();
    const bridge = new CodexOfficeBridge(store);
    const parent = session();
    bridge.sync(parent);
    const parentAgent = [...store.values()][0];
    const child = session();
    child.id = 'child-session';
    child.parent = 'test-session';
    bridge.sync(child);
    const childAgent = [...store.values()].find((a) => a.sessionId === 'codex:child-session')!;
    expect(childAgent.leadAgentId).toBe(parentAgent.id);
    expect(childAgent.agentName).toBe('subagent');
    expect(childAgent.palette).toBe(parentAgent.palette);
    // The parent stays intact when the child finishes and expires.
    bridge.remove('child-session');
    expect(store.has(parentAgent.id)).toBe(true);
    expect(store.has(childAgent.id)).toBe(false);
  });
});
