import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  latestClaudeCwd,
  projectNameForCwd,
  startClaudeDirectoryLabels,
} from '../src/claudeDirectoryLabels.js';
const dirs: string[] = [];
function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-labels-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
test('latest cwd wins over the original log directory; nested output and other sessions cannot rename it', () => {
  const dir = temp(),
    file = path.join(dir, 'MarketingSite.jsonl');
  fs.writeFileSync(
    file,
    [
      { sessionId: 'one', cwd: '/projects/MarketingSite' },
      { sessionId: 'one', cwd: '/projects/ApiServer', padding: 'x'.repeat(70000) },
      { sessionId: 'two', cwd: '/wrong' },
      { sessionId: 'one', isSidechain: true, cwd: '/wrong' },
      { sessionId: 'one', message: { cwd: '/wrong' } },
    ]
      .map((r) => JSON.stringify(r) + '\n')
      .join('') + '{"cwd":"/incomplete"',
  );
  expect(latestClaudeCwd(file, 'one')).toBe('/projects/ApiServer');
});
test('repository subdirectories keep the project name, including git worktree marker files', () => {
  const root = temp(),
    repo = path.join(root, 'ApiServer'),
    sub = path.join(repo, 'website', 'src');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /some/worktree');
  expect(projectNameForCwd(sub)).toBe('ApiServer');
  expect(projectNameForCwd('relative')).toBeUndefined();
});
test('live updates rename only the matching Claude character and broadcast the correction', () => {
  vi.useFakeTimers();
  const root = temp(),
    website = path.join(root, 'Website'),
    watermark = path.join(root, 'Watermark');
  for (const p of [website, watermark]) fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'one', cwd: website }) + '\n');
  const store = new AgentStateStore();
  store.set(
    1,
    createAgentState({
      id: 1,
      sessionId: 'one',
      projectDir: root,
      jsonlFile: file,
      isExternal: true,
      directoryName: 'Website',
    }),
  );
  store.set(
    2,
    createAgentState({
      id: 2,
      sessionId: 'codex:two',
      projectDir: root,
      jsonlFile: file,
      isExternal: true,
      providerId: 'codex',
      directoryName: 'Codex · Unchanged',
    }),
  );
  const events: unknown[] = [];
  store.on('broadcast', (e) => events.push(e));
  const watcher = startClaudeDirectoryLabels(store);
  fs.appendFileSync(file, JSON.stringify({ sessionId: 'one', cwd: watermark }) + '\n');
  vi.advanceTimersByTime(2000);
  expect(store.get(1)?.directoryName).toBe('Watermark');
  expect(store.get(2)?.directoryName).toBe('Codex · Unchanged');
  expect(events).toContainEqual({
    type: 'agentDirectoryChanged',
    id: 1,
    directoryName: 'Watermark',
  });
  watcher.dispose();
});
