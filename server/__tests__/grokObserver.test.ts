import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  emptyGrokSession,
  grokObserver,
  grokSessionCwd,
  reduceGrokRecord,
} from '../src/sessionObservers/grok.js';
import { ObserverOfficeBridge } from '../src/sessionObservers/officeBridge.js';
vi.mock('../src/paletteAssigner.js', () => ({ assignPaletteIfNeeded: () => {} }));

const temps: string[] = [];
const savedHome = process.env.GROK_HOME;
afterEach(async () => {
  if (savedHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedHome;
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** An ACP session/update notification, as Grok Build logs it. */
const update = (sessionUpdate: string, fields: object = {}) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: '0195c3a0-0000-7000-8000-000000000001',
    update: { sessionUpdate, ...fields },
    _meta: { timestamp: new Date().toISOString(), totalTokens: 1200 },
  },
});

describe('Grok turn normalization', () => {
  test('prompt, tool calls by ACP kind, tool completion and turn end', () => {
    const s = emptyGrokSession();
    reduceGrokRecord(s, update('user_message_chunk', { content: { text: 'PRIVATE' } }));
    expect(s).toMatchObject({ phase: 'active', category: 'thinking', seenTurn: true });
    reduceGrokRecord(
      s,
      update('tool_call', { toolCallId: 'a', kind: 'read', title: 'PRIVATE', status: 'pending' }),
    );
    expect(s.category).toBe('reading');
    reduceGrokRecord(s, update('tool_call', { toolCallId: 'b', kind: 'execute' }));
    expect(s.category).toBe('running');
    reduceGrokRecord(s, update('tool_call_update', { toolCallId: 'b', status: 'completed' }));
    expect(s.category).toBe('reading');
    reduceGrokRecord(s, update('tool_call_update', { toolCallId: 'a', status: 'failed' }));
    expect(s).toMatchObject({ phase: 'active', category: 'thinking' });
    reduceGrokRecord(s, update('tool_call', { toolCallId: 'c', kind: 'edit' }));
    expect(s.category).toBe('editing');
    reduceGrokRecord(s, update('turn_completed', { usage: { inputTokens: 10 } }));
    expect(s).toMatchObject({ phase: 'idle' });
    expect(s.tools.size).toBe(0);
    expect(JSON.stringify([...s.tools])).not.toContain('PRIVATE');
  });
  test('the update is accepted bare or under `update` too; other records are ignored', () => {
    const s = emptyGrokSession();
    reduceGrokRecord(s, { sessionUpdate: 'user_message_chunk' });
    expect(s.phase).toBe('active');
    reduceGrokRecord(s, { update: { sessionUpdate: 'turn_completed' } });
    expect(s.phase).toBe('idle');
    reduceGrokRecord(s, { jsonrpc: '2.0', method: 'session/prompt', params: {} });
    expect(s.phase).toBe('idle');
  });
});

describe('session folders', () => {
  test('cwd from summary.json, else the .cwd file, else the URL-encoded folder name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-grok-test-'));
    temps.push(root);
    const a = path.join(root, encodeURIComponent('/projects/api'), 's1');
    await fs.mkdir(a, { recursive: true });
    await fs.writeFile(path.join(a, 'summary.json'), JSON.stringify({ cwd: '/projects/real' }));
    expect(await grokSessionCwd(a)).toBe('/projects/real');
    const b = path.join(root, 'long-path-3f2a', 's2');
    await fs.mkdir(b, { recursive: true });
    await fs.writeFile(path.join(root, 'long-path-3f2a', '.cwd'), '/projects/a/very/long/path\n');
    expect(await grokSessionCwd(b)).toBe('/projects/a/very/long/path');
    const c = path.join(root, encodeURIComponent('/projects/web site'), 's3');
    await fs.mkdir(c, { recursive: true });
    expect(await grokSessionCwd(c)).toBe('/projects/web site');
  });

  test('lists session and subagent logs; a subagent names its session as parent', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-grok-test-'));
    temps.push(home);
    process.env.GROK_HOME = home;
    const session = path.join(home, 'sessions', encodeURIComponent('/projects/api'), 'sess-1');
    const sub = path.join(session, 'subagents', 'sub-1');
    await fs.mkdir(sub, { recursive: true });
    const log = path.join(session, 'updates.jsonl');
    const subLog = path.join(sub, 'updates.jsonl');
    await fs.writeFile(log, JSON.stringify(update('user_message_chunk')) + '\n');
    await fs.writeFile(subLog, JSON.stringify(update('tool_call', { toolCallId: 'x' })) + '\n');
    expect((await grokObserver.listFiles()).sort()).toEqual([log, subLog].sort());

    const main = grokObserver.createReader(log);
    await main.read(log);
    expect(main.session).toMatchObject({ id: 'sess-1', cwd: '/projects/api', phase: 'active' });
    const child = grokObserver.createReader(subLog);
    await child.read(subLog);
    expect(child.session).toMatchObject({
      id: 'sess-1/sub-1',
      parent: 'sess-1',
      cwd: '/projects/api',
    });

    // /rewind truncates the log: the session starts over from what is left.
    await fs.appendFile(log, JSON.stringify(update('turn_completed')) + '\n');
    await main.read(log);
    expect(main.session.phase).toBe('idle');
    await fs.writeFile(log, JSON.stringify(update('user_message_chunk')) + '\n');
    await main.read(log);
    expect(main.session.phase).toBe('active');
  });

  test('records without a time are dated by the log file', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-grok-test-'));
    temps.push(home);
    process.env.GROK_HOME = home;
    const dir = path.join(home, 'sessions', encodeURIComponent('/projects/api'), 'sess-2');
    await fs.mkdir(dir, { recursive: true });
    const log = path.join(dir, 'updates.jsonl');
    await fs.writeFile(log, JSON.stringify({ sessionUpdate: 'user_message_chunk' }) + '\n');
    const reader = grokObserver.createReader(log);
    await reader.read(log);
    expect(Date.now() - reader.session.updated).toBeLessThan(60_000);
  });
});

describe('office integration', () => {
  test('a Grok subagent links to its session when that session is in the office', () => {
    const store = new AgentStateStore();
    const bridge = new ObserverOfficeBridge(store, 'grok', 'Grok', 10 * 60_000);
    const parent = emptyGrokSession();
    Object.assign(parent, { id: 'sess-1', cwd: '/projects/api' });
    reduceGrokRecord(parent, update('user_message_chunk'));
    bridge.sync(parent);
    const child = emptyGrokSession();
    Object.assign(child, { id: 'sess-1/sub-1', cwd: '/projects/api', parent: 'sess-1' });
    reduceGrokRecord(child, update('tool_call', { toolCallId: 'x', kind: 'search' }));
    bridge.sync(child);
    const [lead, helper] = [...store.values()];
    expect(lead.directoryName).toBe('Grok · api');
    expect(helper.directoryName).toBe('Grok · api · subagent');
    expect(helper.leadAgentId).toBe(lead.id);
    expect(helper.activeToolStatuses.get(`grok-activity-${helper.id}`)).toBe(
      'Grok: reading / searching',
    );
  });
});
