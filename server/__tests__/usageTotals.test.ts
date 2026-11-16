import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { PRIVILEGED_BROADCAST_TYPES } from '../src/usageLimits.js';
import {
  claudeSessionOf,
  ClaudeUsageReducer,
  CodexUsageReducer,
  localDay,
  LogFollower,
  SessionUsage,
  USAGE_FIRST_READ_MAX_BYTES,
  UsageTotals,
} from '../src/usageTotals.js';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-usage-'));
  temps.push(dir);
  return dir;
}

const NOW = new Date(2026, 10, 16, 15, 0, 0).getTime();
const TODAY = localDay(NOW);
const YESTERDAY_LATE = new Date(2026, 10, 15, 23, 59, 0).getTime();

function assistant(
  id: string,
  usage: Record<string, number>,
  at = NOW,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    cwd: '/projects/ApiServer',
    message: { id, model: 'claude-test', usage },
    ...extra,
  };
}

function tokenCount(total: Record<string, number>, at = NOW, window = 400_000) {
  return {
    type: 'event_msg',
    timestamp: new Date(at).toISOString(),
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, model_context_window: window },
    },
  };
}

describe('Claude usage', () => {
  test('a message repeated across lines counts once, at its largest reading', () => {
    const r = new ClaudeUsageReducer();
    const s = new SessionUsage();
    const usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100 };
    r.reduce(s, assistant('m1', usage));
    r.reduce(s, assistant('m1', usage));
    // A streaming line with a partial count, then the final one.
    r.reduce(s, assistant('m1', { ...usage, output_tokens: 5 }));
    r.reduce(s, assistant('m1', { ...usage, output_tokens: 40 }));
    expect(s.today(TODAY)).toEqual([
      { model: 'claude-test', input: 2, output: 40, cacheRead: 100, cacheWrite: 0 },
    ]);
  });

  test('the same message in two files (a resumed session) counts once', () => {
    const r = new ClaudeUsageReducer();
    const a = new SessionUsage();
    const b = new SessionUsage();
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 50 };
    r.reduce(a, assistant('m1', usage));
    r.reduce(b, assistant('m1', usage));
    expect(a.today(TODAY)).toHaveLength(1);
    expect(b.today(TODAY)).toEqual([]);
  });

  test("yesterday's messages are not today's, and synthetic zeros are skipped", () => {
    const r = new ClaudeUsageReducer();
    const s = new SessionUsage();
    r.reduce(s, assistant('old', { output_tokens: 9 }, YESTERDAY_LATE));
    r.reduce(s, assistant('zero', { input_tokens: 0, output_tokens: 0 }));
    expect(s.today(TODAY)).toEqual([]);
  });

  test('compactions count main-chain boundaries only', () => {
    const r = new ClaudeUsageReducer();
    const s = new SessionUsage();
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: '' };
    r.reduce(s, boundary);
    r.reduce(s, { ...boundary, isSidechain: true });
    r.reduce(s, boundary);
    expect(s.compactions).toBe(2);
  });

  test('subagent files belong to their parent session', () => {
    expect(claudeSessionOf('/p/-proj/abc.jsonl')).toBe('abc');
    expect(claudeSessionOf('/p/-proj/abc/subagents/agent-x.jsonl')).toBe('abc');
  });
});

describe('Codex usage', () => {
  test('running totals become deltas, cached input split out, credited by day', () => {
    const s = new SessionUsage();
    const r = new CodexUsageReducer(s);
    r.reduce({ type: 'turn_context', payload: { model: 'gpt-test', cwd: '/projects/ApiServer' } });
    r.reduce(
      tokenCount(
        { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 },
        YESTERDAY_LATE,
      ),
    );
    r.reduce(tokenCount({ input_tokens: 3000, cached_input_tokens: 2500, output_tokens: 30 }));
    expect(s.today(TODAY)).toEqual([
      { model: 'gpt-test', input: 300, output: 20, cacheRead: 1700, cacheWrite: 0 },
    ]);
    expect(s.contextWindow).toBe(400_000);
  });

  test('a counter that went down restarted: the new total is all new', () => {
    const s = new SessionUsage();
    const r = new CodexUsageReducer(s);
    r.reduce(tokenCount({ input_tokens: 500, output_tokens: 5 }));
    r.reduce(tokenCount({ input_tokens: 100, output_tokens: 1 }));
    expect(s.today(TODAY)[0]).toMatchObject({ input: 600, output: 6 });
  });

  test('read from mid-file, the first total is only a baseline', () => {
    const s = new SessionUsage();
    const r = new CodexUsageReducer(s, true);
    r.reduce(tokenCount({ input_tokens: 9000, output_tokens: 90 }));
    r.reduce(tokenCount({ input_tokens: 9100, output_tokens: 95 }));
    expect(s.today(TODAY)[0]).toMatchObject({ input: 100, output: 5 });
  });

  test('compacted records count', () => {
    const s = new SessionUsage();
    const r = new CodexUsageReducer(s);
    r.reduce({ type: 'compacted', payload: {} });
    expect(s.compactions).toBe(1);
  });
});

describe('LogFollower', () => {
  test('reads incrementally, skips lines without the keys, survives malformed lines', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.jsonl');
    const seen: unknown[] = [];
    const f = new LogFollower(file, ['"usage"'], (r) => seen.push(r));
    await fs.writeFile(file, '{"usage":1}\n{"other":2}\n{"usage":bad\n{"usa');
    await f.step();
    expect(seen).toEqual([{ usage: 1 }]);
    await fs.appendFile(file, 'ge":3}\n');
    await f.step();
    expect(seen).toEqual([{ usage: 1 }, { usage: 3 }]);
  });

  test('a large file is read from its tail, dropping the cut record', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'big.jsonl');
    const filler = `{"pad":"${'x'.repeat(1000)}"}\n`;
    const count = Math.ceil(USAGE_FIRST_READ_MAX_BYTES / filler.length) + 10;
    await fs.writeFile(file, `{"usage":"head"}\n${filler.repeat(count)}{"usage":"tail"}\n`);
    const seen: unknown[] = [];
    let midFile: boolean | undefined;
    const f = new LogFollower(file, ['"usage"'], (r) => seen.push(r));
    f.onStart = (m) => (midFile = m);
    while (await f.step());
    expect(midFile).toBe(true);
    expect(seen).toEqual([{ usage: 'tail' }]);
  });

  test('a rewritten (shorter) file starts over', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.jsonl');
    const seen: unknown[] = [];
    let starts = 0;
    const f = new LogFollower(file, ['"usage"'], (r) => seen.push(r));
    f.onStart = () => starts++;
    await fs.writeFile(file, '{"usage":1}\n{"usage":2}\n');
    await f.step();
    await fs.writeFile(file, '{"usage":9}\n');
    await f.step();
    expect(starts).toBe(2);
    expect(seen.at(-1)).toEqual({ usage: 9 });
  });
});

describe('UsageTotals', () => {
  test('totals per agent (by session) and per project, from today’s logs', async () => {
    const home = await tempDir();
    const projects = path.join(home, 'claude');
    const projectDir = path.join(projects, '-projects-ApiServer');
    await fs.mkdir(path.join(projectDir, 'sess-1', 'subagents'), { recursive: true });
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    await fs.writeFile(
      path.join(projectDir, 'sess-1.jsonl'),
      line(assistant('m1', { input_tokens: 10, output_tokens: 20 }, Date.now())),
    );
    await fs.writeFile(
      path.join(projectDir, 'sess-1', 'subagents', 'agent-a.jsonl'),
      line(assistant('m2', { input_tokens: 1, output_tokens: 2 }, Date.now())),
    );
    const totals = new UsageTotals({ claudeProjects: projects });
    await totals.scan();
    while (await totals.read());

    const store = new AgentStateStore();
    store.set(
      7,
      createAgentState({
        id: 7,
        sessionId: 'sess-1',
        isExternal: true,
        projectDir,
        jsonlFile: path.join(projectDir, 'sess-1.jsonl'),
      }),
    );
    const msg = totals.message(store);
    expect(msg.type).toBe('usageToday');
    expect(msg.agents).toEqual([
      {
        id: 7,
        models: [{ model: 'claude-test', input: 11, output: 22, cacheRead: 0, cacheWrite: 0 }],
        compactions: 0,
        project: 'ApiServer',
      },
    ]);
    expect(msg.projects).toEqual([
      {
        name: 'ApiServer',
        models: [{ model: 'claude-test', input: 11, output: 22, cacheRead: 0, cacheWrite: 0 }],
      },
    ]);
  });

  test('usage is withheld from read-only sockets', () => {
    expect(PRIVILEGED_BROADCAST_TYPES.has('usageToday')).toBe(true);
  });
});
