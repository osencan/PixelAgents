import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearAllHistory, startAgentLifecycle } from '../src/agentLifecycle.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  boundHistory,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_BYTES,
  readHistoryFile,
} from '../src/historyFile.js';
import { PRIVILEGED_BROADCAST_TYPES } from '../src/usageLimits.js';
import { parseShortStat } from '../src/workingTree.js';
import { displayPath, reduceWorkItems, replyLine, WORK_FILES_MAX } from '../src/workItems.js';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-history-'));
  temps.push(dir);
  return path.join(dir, name);
}

function agent(id: number, sessionId: string) {
  const a = createAgentState({
    id,
    sessionId,
    projectDir: '/p',
    jsonlFile: `/p/${sessionId}.jsonl`,
    isExternal: true,
  });
  a.hookDelivered = true;
  a.lastDataAt = Date.now();
  return a;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('history on disk', () => {
  it('a restart restores an agent’s history by session, under its new id', async () => {
    const file = tempFile('history.json');
    const first = new AgentStateStore();
    const life1 = startAgentLifecycle(first, { historyFile: file });
    first.set(1, agent(1, 'sess-a'));
    await flush();
    first.broadcast({ type: 'agentToolFailed', id: 1, at: Date.now() });
    await flush();
    life1.dispose(); // flushes the pending write
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sess-a'); // keys are hashed

    const second = new AgentStateStore();
    const sent: Record<string, unknown>[] = [];
    const life2 = startAgentLifecycle(second, { historyFile: file });
    second.set(9, agent(9, 'sess-a'));
    await flush();
    life2.snapshot((m) => sent.push(m));
    const history = sent.find((m) => m.type === 'agentHistory' && m.id === 9);
    expect(
      (history?.entries as Array<{ kind: string }>).some((e) => e.kind === 'tool_failed'),
    ).toBe(true);
    life2.dispose();
  });

  it('Clear forgets everything, on disk too, and tells clients', async () => {
    const file = tempFile('history.json');
    const store = new AgentStateStore();
    const life = startAgentLifecycle(store, { historyFile: file });
    store.set(1, agent(1, 'sess-b'));
    await flush();
    store.broadcast({ type: 'agentToolFailed', id: 1, at: Date.now() });
    const out: Record<string, unknown>[] = [];
    store.on('broadcast', (m) => out.push(m));
    clearAllHistory(store);
    expect(out).toContainEqual({ type: 'agentHistory', id: 1, entries: [] });
    expect(readHistoryFile(file).size).toBe(0);
    life.dispose();
  });

  it('without a file, nothing is written (tests, the VS Code adapter)', async () => {
    const store = new AgentStateStore();
    const life = startAgentLifecycle(store);
    store.set(1, agent(1, 'sess-c'));
    await flush();
    life.dispose();
  });

  it('drops entries older than a day and trims oldest-first to the size cap', () => {
    const now = Date.now();
    const old = { kind: 'tool_failed' as const, at: now - HISTORY_MAX_AGE_MS - 1 };
    const many = Array.from({ length: 5000 }, (_, i) => ({
      kind: 'tool_failed' as const,
      at: now - 5000 + i,
      project: 'ApiServer',
    }));
    const bounded = boundHistory(new Map([['k', [old, ...many]]]), now);
    expect(JSON.stringify({ version: 1, agents: bounded }).length).toBeLessThanOrEqual(
      HISTORY_MAX_BYTES,
    );
    const kept = bounded.k;
    expect(kept.some((e) => e.at === old.at)).toBe(false);
    expect(kept.at(-1)?.at).toBe(now - 1); // the newest survive
  });

  it('reading ignores malformed and expired entries', () => {
    const file = tempFile('history.json');
    const now = Date.now();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        agents: {
          a: [{ kind: 'tool_failed', at: now }, { bogus: true }],
          b: [{ kind: 'state', at: 1 }],
        },
      }),
    );
    const read = readHistoryFile(file, now);
    expect(read.get('a')).toHaveLength(1);
    expect(read.has('b')).toBe(false);
  });
});

describe('work items', () => {
  const items = () =>
    ({ todos: [], files: [] as string[] }) as Parameters<typeof reduceWorkItems>[0];
  const toolUse = (name: string, input: object, extra: object = {}) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't', name, input }] },
    ...extra,
  });

  it('keeps the latest TodoWrite list', () => {
    const a = agent(1, 's');
    const it = items();
    reduceWorkItems(
      it,
      a,
      toolUse('TodoWrite', { todos: [{ content: 'one', status: 'pending' }] }),
    );
    reduceWorkItems(
      it,
      a,
      toolUse('TodoWrite', {
        todos: [
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'in_progress' },
        ],
      }),
    );
    expect(it.todos).toEqual([
      { text: 'one', status: 'completed' },
      { text: 'two', status: 'in_progress' },
    ]);
  });

  it('edited files, newest first, de-duplicated, relative to the project, capped', () => {
    const a = agent(1, 's');
    a.projectRoot = '/projects/ApiServer';
    const it = items();
    for (let i = 0; i < WORK_FILES_MAX + 2; i++) {
      reduceWorkItems(it, a, toolUse('Edit', { file_path: `/projects/ApiServer/src/f${i}.ts` }));
    }
    reduceWorkItems(it, a, toolUse('Write', { file_path: '/projects/ApiServer/src/f3.ts' }));
    reduceWorkItems(it, a, toolUse('Read', { file_path: '/projects/ApiServer/README.md' }));
    expect(it.files).toHaveLength(WORK_FILES_MAX);
    expect(it.files[0]).toBe(path.join('src', 'f3.ts'));
    expect(it.files.filter((f) => f.endsWith('f3.ts'))).toHaveLength(1);
    expect(it.files).not.toContain('README.md');
  });

  it('a sidechain turn after a main-chain one is someone else’s', () => {
    const a = agent(1, 's');
    a.sawMainChainUsage = true;
    const it = items();
    expect(
      reduceWorkItems(it, a, toolUse('Edit', { file_path: '/x' }, { isSidechain: true })),
    ).toBe(false);
  });

  it('takes Claude’s generated title', () => {
    const it = items();
    reduceWorkItems(it, agent(1, 's'), { type: 'ai-title', aiTitle: 'Fix the login flow' });
    expect(it.title).toBe('Fix the login flow');
  });

  it('paths outside the project stay absolute', () => {
    expect(displayPath('/elsewhere/a.ts', '/projects/ApiServer')).toBe('/elsewhere/a.ts');
    expect(displayPath('/projects/ApiServer/a.ts', '/projects/ApiServer')).toBe('a.ts');
  });

  it('is for tokened sockets only, like uncommitted changes', () => {
    expect(PRIVILEGED_BROADCAST_TYPES.has('agentWorkItems')).toBe(true);
    expect(PRIVILEGED_BROADCAST_TYPES.has('workingTreeChanges')).toBe(true);
  });
});

describe('git --shortstat', () => {
  it('parses counts, singular and plural, and a clean tree', () => {
    expect(parseShortStat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({
      files: 3,
      insertions: 10,
      deletions: 2,
    });
    expect(parseShortStat(' 1 file changed, 1 deletion(-)\n')).toEqual({
      files: 1,
      insertions: 0,
      deletions: 1,
    });
    expect(parseShortStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe('reply line', () => {
  it('takes the first non-empty line, without markdown marks', () => {
    expect(replyLine('\n\n## **Done.** All `tests` pass\nMore')).toBe('Done. All tests pass');
    expect(replyLine('   \n')).toBeUndefined();
    expect(replyLine('x'.repeat(500))?.length).toBe(120);
  });

  it('keeps the latest main-chain reply', () => {
    const it = { todos: [], files: [] } as Parameters<typeof reduceWorkItems>[0];
    const a = agent(1, 's');
    const text = (t: string, extra: object = {}) => ({
      type: 'assistant',
      message: { content: [{ type: 'text', text: t }] },
      ...extra,
    });
    reduceWorkItems(it, a, text('First answer'));
    reduceWorkItems(it, a, text('A subagent talking', { isSidechain: true }));
    expect(it.reply).toBe('First answer');
  });
});
