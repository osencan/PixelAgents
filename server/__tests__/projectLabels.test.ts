import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let home: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => home };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => home };
});

const { createAgentState } = await import('../src/agentState.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { startClaudeDirectoryLabels } = await import('../src/claudeDirectoryLabels.js');
const { readProjectLabels, resetProjectLabelCache, setProjectLabel } =
  await import('../src/projectLabels.js');

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-plabels-')));
  resetProjectLabelCache();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a pinned display name applies to every agent of that project, and unpinning restores it', () => {
  vi.useFakeTimers();
  const main = path.join(home, 'MarketingSite');
  const wt = path.join(home, 'site-feature');
  const wtGit = path.join(main, '.git', 'worktrees', 'site-feature');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);

  const store = new AgentStateStore();
  const codex = createAgentState({
    id: 1,
    sessionId: 'codex:a',
    projectDir: wt,
    jsonlFile: '',
    isExternal: true,
    providerId: 'codex',
    directoryName: 'Codex · x',
  });
  codex.projectCwd = wt;
  store.set(1, codex);
  const events: Array<Record<string, unknown>> = [];
  store.on('broadcast', (e) => events.push(e));
  const watcher = startClaudeDirectoryLabels(store);
  expect(store.get(1)?.directoryName).toBe('Codex · MarketingSite');
  expect(events.at(-1)).toMatchObject({ type: 'agentDirectoryChanged', worktree: 'site-feature' });

  setProjectLabel(main, '  Website ');
  expect(readProjectLabels()).toEqual({ [main]: 'Website' });
  vi.advanceTimersByTime(2000);
  expect(store.get(1)?.directoryName).toBe('Codex · Website');
  // Persisted privately under the (test) home.
  expect(
    JSON.parse(fs.readFileSync(path.join(home, '.pixel-agents', 'project-labels.json'), 'utf8')),
  ).toEqual({
    [main]: 'Website',
  });

  setProjectLabel(main, '');
  vi.advanceTimersByTime(2000);
  expect(store.get(1)?.directoryName).toBe('Codex · MarketingSite');
  watcher.dispose();
});
