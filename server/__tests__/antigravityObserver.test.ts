import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { describe, expect, test, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  antigravityObserver,
  antigravityWorkspace,
  emptyAntigravitySession,
  reduceAntigravityStep,
  sqliteMissingWarning,
  toolCategory,
} from '../src/sessionObservers/antigravity.js';
import { ObserverOfficeBridge } from '../src/sessionObservers/officeBridge.js';
vi.mock('../src/paletteAssigner.js', () => ({ assignPaletteIfNeeded: () => {} }));

let index = 0;
const at = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const step = (type: string, fields: object = {}) => ({
  step_index: index++,
  source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  type,
  status: 'DONE',
  created_at: at(),
  ...fields,
});
const prompt = () => step('USER_INPUT', { content: 'PRIVATE' });
const calls = (...names: string[]) =>
  step('PLANNER_RESPONSE', {
    thinking: 'PRIVATE',
    tool_calls: names.map((name) => ({ name, args: { AbsolutePath: 'PRIVATE' } })),
  });
const result = () => step('GENERIC', { content: 'PRIVATE' });
const answer = () => step('PLANNER_RESPONSE', { content: 'PRIVATE' });

/** The workspace field as the app stores it: a length-prefixed protobuf string among others. */
function metadataBlob(cwd: string): Buffer {
  const uri = Buffer.from(pathToFileURL(cwd).href);
  const length = uri.length < 128 ? [uri.length] : [(uri.length & 0x7f) | 0x80, uri.length >> 7];
  return Buffer.concat([
    Buffer.from([0x12, 0x03]),
    Buffer.from('abc'),
    Buffer.from([0x2a, ...length]),
    uri,
    Buffer.from([0x7a, 0x01, 0x00]),
  ]);
}
async function conversation(home: string, product: string, id: string, cwd: string) {
  const root = path.join(home, '.gemini', product);
  const logs = path.join(root, 'brain', id, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  await fs.mkdir(path.join(root, 'conversations'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'conversations', `${id}.db`));
  db.exec('CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob)');
  db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(metadataBlob(cwd));
  db.close();
  return path.join(logs, 'transcript.jsonl');
}
const lines = (...records: object[]) => records.map((r) => JSON.stringify(r) + '\n').join('');

describe('Antigravity turn normalization', () => {
  test('a prompt starts a turn, tool calls set the category, a reply without tools ends it', () => {
    const s = emptyAntigravitySession();
    reduceAntigravityStep(s, prompt());
    expect(s).toMatchObject({ phase: 'active', category: 'thinking', seenTurn: true });
    reduceAntigravityStep(s, calls('run_command', 'read_file', 'view_file'));
    expect(s.category).toBe('reading');
    reduceAntigravityStep(s, result());
    expect(s).toMatchObject({ phase: 'active', category: 'reading' });
    reduceAntigravityStep(s, calls('multi_replace_file_content'));
    expect(s.category).toBe('editing');
    reduceAntigravityStep(s, calls('run_command'));
    expect(s.category).toBe('running');
    reduceAntigravityStep(s, answer());
    expect(s.phase).toBe('idle');
  });
  test('planning tools do no work: a step shows its last real tool, or thinking', () => {
    const s = emptyAntigravitySession();
    reduceAntigravityStep(s, prompt());
    reduceAntigravityStep(s, calls('edit_file', 'update_steps', 'update_focus'));
    expect(s.category).toBe('editing');
    reduceAntigravityStep(s, calls('manage_task'));
    expect(s).toMatchObject({ phase: 'active', category: 'thinking' });
  });
  test('a refused attempt (empty response, error step) keeps the turn going', () => {
    const s = emptyAntigravitySession();
    reduceAntigravityStep(s, prompt());
    reduceAntigravityStep(s, step('PLANNER_RESPONSE'));
    reduceAntigravityStep(s, step('ERROR_MESSAGE', { error_code: 429, content: 'x' }));
    reduceAntigravityStep(s, step('PLANNER_RESPONSE'));
    expect(s).toMatchObject({ phase: 'active', category: 'thinking' });
  });
  test('tool names of the IDE and of the 2.0 app', () => {
    expect(toolCategory('grep_search')).toBe('reading');
    expect(toolCategory('read_file')).toBe('reading');
    expect(toolCategory('write_to_file')).toBe('editing');
    expect(toolCategory('replace')).toBe('editing');
    expect(toolCategory('send_command_input')).toBe('running');
    expect(toolCategory('invoke_subagent')).toBe('tool');
  });
});

describe('conversation files', () => {
  test('the workspace comes from the conversation database, short or long paths', async () => {
    const home = os.homedir();
    const long = '/projects/' + 'deep/'.repeat(30) + 'site';
    await conversation(home, 'antigravity-ide', 'c1', '/projects/site');
    await conversation(home, 'antigravity-ide', 'c2', long);
    const dbs = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
    expect(await antigravityWorkspace(path.join(dbs, 'c1.db'))).toBe('/projects/site');
    expect(await antigravityWorkspace(path.join(dbs, 'c2.db'))).toBe(long);
    expect(await antigravityWorkspace(path.join(dbs, 'missing.db'))).toBe('');
  });

  test('without node:sqlite the conversation is skipped and the server says why, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noSqlite = () => Promise.reject(new Error('No such built-in module: node:sqlite'));
    expect(await antigravityWorkspace('/any/c1.db', noSqlite)).toBe('');
    expect(await antigravityWorkspace('/any/c2.db', noSqlite)).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(sqliteMissingWarning(process.version));
    expect(sqliteMissingWarning('v20.11.0')).toContain('Node 22.5 or later (Node v20.11.0');
    warn.mockRestore();
  });

  test('lists every product’s transcripts and follows one as it grows', async () => {
    const home = os.homedir();
    const ide = await conversation(home, 'antigravity-ide', 'a1', '/projects/site');
    const app = await conversation(home, 'antigravity', 'b2', '/projects/api');
    await fs.writeFile(ide, lines(prompt(), calls('view_file')));
    await fs.writeFile(app, lines(prompt()));
    // A brain folder holding only artifacts is no conversation log.
    await fs.mkdir(path.join(home, '.gemini', 'antigravity', 'brain', 'old'), { recursive: true });
    expect((await antigravityObserver.listFiles()).sort()).toEqual([ide, app].sort());

    const reader = antigravityObserver.createReader(ide);
    await reader.read(ide);
    expect(reader.session).toMatchObject({
      id: 'antigravity-ide/a1',
      cwd: '/projects/site',
      phase: 'active',
      category: 'reading',
    });
    await fs.appendFile(ide, lines(result(), answer()));
    await reader.read(ide);
    expect(reader.session.phase).toBe('idle');
  });
});

describe('office integration', () => {
  test('Antigravity characters are labelled, not persisted, and keep no content', () => {
    const store = new AgentStateStore();
    const bridge = new ObserverOfficeBridge(store, 'antigravity', 'Antigravity', 10 * 60_000);
    const s = emptyAntigravitySession();
    Object.assign(s, { id: 'antigravity/b2', cwd: '/projects/api' });
    reduceAntigravityStep(s, prompt());
    reduceAntigravityStep(s, calls('run_command'));
    bridge.sync(s);
    const agent = [...store.values()][0];
    expect(agent).toMatchObject({
      providerId: 'antigravity',
      sessionId: 'antigravity:antigravity/b2',
      directoryName: 'Antigravity · api',
      observedCategory: 'running',
    });
    expect(agent.activeToolStatuses.get(`antigravity-activity-${agent.id}`)).toBe(
      'Antigravity: running a command',
    );
    expect(toPersistedAgent(agent)).toBeNull();
    expect(JSON.stringify([...agent.activeToolStatuses])).not.toContain('PRIVATE');
  });
});
