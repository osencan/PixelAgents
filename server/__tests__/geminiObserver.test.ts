import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  emptyGeminiSession,
  geminiObserver,
  geminiProjectCwd,
  reduceGeminiDocument,
  reduceGeminiLine,
} from '../src/sessionObservers/gemini.js';
import { ObserverOfficeBridge } from '../src/sessionObservers/officeBridge.js';
vi.mock('../src/paletteAssigner.js', () => ({ assignPaletteIfNeeded: () => {} }));

const temps: string[] = [];
const savedHome = process.env.GEMINI_CLI_HOME;
afterEach(async () => {
  if (savedHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = savedHome;
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-gemini-test-'));
  temps.push(dir);
  process.env.GEMINI_CLI_HOME = dir;
  return dir;
}

const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const user = (id: string) => ({
  id,
  type: 'user',
  timestamp: at(),
  content: [{ text: 'PRIVATE' }],
});
const reply = (id: string, ...tools: string[]) => ({
  id,
  type: 'gemini',
  timestamp: at(),
  content: 'PRIVATE',
  toolCalls: tools.map((name, i) => ({
    id: `${id}-${i}`,
    name,
    args: { file_path: 'PRIVATE' },
    result: [{ functionResponse: { response: { output: 'PRIVATE' } } }],
    status: 'success',
  })),
});
const doc = (messages: object[], extra: object = {}) => ({
  sessionId: 'b0a1',
  projectHash: 'x',
  startTime: at(),
  lastUpdated: at(),
  messages,
  ...extra,
});

describe('Gemini turn normalization', () => {
  test('a prompt starts a turn, tool rounds keep it going, a plain reply ends it', () => {
    const s = emptyGeminiSession();
    reduceGeminiDocument(s, doc([user('u1')]));
    expect(s).toMatchObject({ phase: 'active', category: 'thinking', seenTurn: true });
    reduceGeminiDocument(s, doc([user('u1'), reply('g1', 'read_file')]));
    expect(s).toMatchObject({ phase: 'active', category: 'reading' });
    reduceGeminiDocument(s, doc([user('u1'), reply('g1', 'read_file'), reply('g2', 'replace')]));
    expect(s.category).toBe('editing');
    reduceGeminiDocument(
      s,
      doc([user('u1'), reply('g1', 'read_file'), reply('g2', 'run_shell_command')]),
    );
    expect(s.category).toBe('running');
    reduceGeminiDocument(
      s,
      doc([user('u1'), reply('g1', 'read_file'), reply('g2', 'mcp_thing'), reply('g3')]),
    );
    expect(s.phase).toBe('idle');
    expect(JSON.stringify([...s.messages])).not.toContain('PRIVATE');
  });
  test('info and error messages do not change the phase; no prompt means no session', () => {
    const s = emptyGeminiSession();
    reduceGeminiDocument(s, doc([{ id: 'i', type: 'info', content: 'PRIVATE' }]));
    expect(s.seenTurn).toBe(false);
    reduceGeminiDocument(s, doc([user('u1'), reply('g1'), { id: 'e', type: 'error' }]));
    expect(s.phase).toBe('idle');
  });
  test('a subagent session is marked as one', () => {
    const s = emptyGeminiSession();
    reduceGeminiDocument(s, doc([user('u1')], { kind: 'subagent' }));
    expect(s.subagent).toBe(true);
  });
  test('JSONL: header, whole messages and $set patches', () => {
    const s = emptyGeminiSession();
    reduceGeminiLine(s, {
      sessionId: 'a2a-server',
      kind: 'main',
      lastUpdated: at(),
      startTime: at(),
    });
    expect(s.seenTurn).toBe(false);
    reduceGeminiLine(s, user('u1'));
    expect(s.phase).toBe('active');
    reduceGeminiLine(s, reply('g1', 'glob'));
    expect(s.category).toBe('reading');
    reduceGeminiLine(s, { $set: { messages: [user('u1'), reply('g1', 'glob'), reply('g2')] } });
    expect(s.phase).toBe('idle');
    reduceGeminiLine(s, { $set: { lastUpdated: at() } });
    expect(s.phase).toBe('idle');
    expect(s.messages.size).toBe(3);
  });
});

describe('project folders', () => {
  test('cwd from .project_root, else projects.json by slug or by the old sha256 name', async () => {
    const home = await tempHome();
    const gemini = path.join(home, '.gemini');
    const slugDir = path.join(gemini, 'tmp', 'site');
    await fs.mkdir(slugDir, { recursive: true });
    await fs.writeFile(path.join(slugDir, '.project_root'), '/projects/site\n');
    expect(await geminiProjectCwd(slugDir, gemini)).toBe('/projects/site');

    const hashed = createHash('sha256').update('/projects/old').digest('hex');
    const hashDir = path.join(gemini, 'tmp', hashed);
    const otherDir = path.join(gemini, 'tmp', 'other');
    await fs.mkdir(hashDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      path.join(gemini, 'projects.json'),
      JSON.stringify({ projects: { '/projects/old': 'old', '/projects/other': 'other' } }),
    );
    expect(await geminiProjectCwd(hashDir, gemini)).toBe('/projects/old');
    expect(await geminiProjectCwd(otherDir, gemini)).toBe('/projects/other');
    expect(await geminiProjectCwd(path.join(gemini, 'tmp', 'unknown'), gemini)).toBe('');
  });

  test('lists .json and .jsonl sessions and reads them by file identity', async () => {
    const home = await tempHome();
    const chats = path.join(home, '.gemini', 'tmp', 'site', 'chats');
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, '..', '.project_root'), '/projects/site');
    const json = path.join(chats, 'session-2026-11-23T10-00-b0a1c2d3.json');
    const jsonl = path.join(chats, 'session-2026-11-23T10-05-a2a-serv.jsonl');
    await fs.writeFile(json, JSON.stringify(doc([user('u1'), reply('g1', 'write_file')])));
    await fs.writeFile(
      jsonl,
      [
        JSON.stringify({ sessionId: 'a2a-server', kind: 'main', lastUpdated: at() }),
        JSON.stringify(user('u1')),
      ].join('\n') + '\n',
    );
    await fs.writeFile(path.join(chats, 'notes.txt'), 'not a session');
    expect((await geminiObserver.listFiles()).sort()).toEqual([json, jsonl].sort());

    const reader = geminiObserver.createReader(json);
    await reader.read(json);
    expect(reader.session).toMatchObject({
      id: 'site/session-2026-11-23T10-00-b0a1c2d3',
      cwd: '/projects/site',
      phase: 'active',
      category: 'editing',
    });
    // The file is rewritten whole: the next read sees the finished turn.
    await fs.writeFile(
      json,
      JSON.stringify(doc([user('u1'), reply('g1', 'write_file'), reply('g2')])),
    );
    await reader.read(json);
    expect(reader.session.phase).toBe('idle');

    const tail = geminiObserver.createReader(jsonl);
    await tail.read(jsonl);
    expect(tail.session).toMatchObject({
      id: 'site/session-2026-11-23T10-05-a2a-serv',
      cwd: '/projects/site',
      phase: 'active',
    });
  });

  test('a file caught mid-write is read again on the next poll', async () => {
    const home = await tempHome();
    const chats = path.join(home, '.gemini', 'tmp', 'site', 'chats');
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, '..', '.project_root'), '/projects/site');
    const json = path.join(chats, 'session-x.json');
    await fs.writeFile(json, '{"sessionId": "b0a1", "messa');
    const reader = geminiObserver.createReader(json);
    await expect(reader.read(json)).rejects.toThrow();
    await fs.writeFile(json, JSON.stringify(doc([user('u1')])));
    await reader.read(json);
    expect(reader.session.phase).toBe('active');
  });
});

describe('office integration', () => {
  test('Gemini characters are labelled, not persisted, and a quiet turn shows as waiting', () => {
    const store = new AgentStateStore();
    const bridge = new ObserverOfficeBridge(store, 'gemini', 'Gemini', 10 * 60_000);
    const s = emptyGeminiSession();
    s.id = 'site/session-x';
    s.cwd = '/projects/site';
    reduceGeminiDocument(s, doc([user('u1'), reply('g1', 'replace')]));
    bridge.sync(s);
    const agent = [...store.values()][0];
    expect(agent).toMatchObject({
      providerId: 'gemini',
      sessionId: 'gemini:site/session-x',
      directoryName: 'Gemini · site',
      turnActive: true,
      observedCategory: 'editing',
    });
    expect(agent.activeToolStatuses.get(`gemini-activity-${agent.id}`)).toBe('Gemini: editing');
    expect(toPersistedAgent(agent)).toBeNull();
    bridge.sync(s, s.updated + 11 * 60_000);
    expect(agent.turnActive).toBe(false);
    expect(agent.isWaiting).toBe(true);
    expect(agent.observedCategory).toBeUndefined();
  });
});
