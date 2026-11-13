import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentCreatedMessage } from '../src/agentMessages.js';
import { toPersistedAgent } from '../src/agentPersistence.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FORK_ADOPT_RECENT_MS, FORK_STALE_MS } from '../src/constants.js';
import {
  scanForForkAgentFiles,
  setHookProvider as setFileWatcherHookProvider,
  setShowSubtaskAgents,
  setTeammateRemovalCallback,
  setTeamProvider,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { setHookProvider } from '../src/transcriptParser.js';

const LEAD_SESSION = 'lead-session-1';

/** The shape Claude Code writes for a /subtask fork (2026-11): no toolUseId. */
const forkMeta = (finished?: boolean) => ({
  agentType: 'fork',
  isFork: true,
  isBuiltIn: true,
  description: 'restarted. also opening claude terminal…',
  name: 'restarted-also-opening',
  spawnDepth: 1,
  requestShape: 'background',
  model: 'inherit',
  ...(finished ? { finished: true } : {}),
});

describe('forks (/subtask) become characters under their lead', () => {
  let tmpRoot: string;
  let agents: AgentStateStore;
  let removed: number[];
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  const fileWatchers = new Map<number, fs.FSWatcher>();
  const nextId = { current: 100 };

  const subagentsDir = () => path.join(tmpRoot, LEAD_SESSION, 'subagents');

  function seed(file: string, meta: Record<string, unknown>, mtimeAgoMs = 0): string {
    fs.mkdirSync(subagentsDir(), { recursive: true });
    const jsonl = path.join(subagentsDir(), `${file}.jsonl`);
    fs.writeFileSync(
      jsonl,
      JSON.stringify({ type: 'fork-context-ref', agentId: file, parentSessionId: LEAD_SESSION }) +
        '\n',
    );
    fs.writeFileSync(path.join(subagentsDir(), `${file}.meta.json`), JSON.stringify(meta));
    const t = (Date.now() - mtimeAgoMs) / 1000;
    fs.utimesSync(jsonl, t, t);
    return jsonl;
  }

  const scan = (now = Date.now()) =>
    scanForForkAgentFiles(
      1,
      agents,
      nextId,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      undefined,
      now,
    );

  const forks = () => [...agents.values()].filter((a) => a.isFork);

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-fork-'));
    setHookProvider(claudeProvider);
    setFileWatcherHookProvider(claudeProvider);
    setTeamProvider(claudeTeamProvider);
    agents = new AgentStateStore();
    agents.set(
      1,
      createAgentState({
        id: 1,
        sessionId: LEAD_SESSION,
        isExternal: true,
        projectDir: tmpRoot,
        jsonlFile: path.join(tmpRoot, `${LEAD_SESSION}.jsonl`),
        directoryName: 'PixelAgents',
        projectRoot: '/work/PixelAgents',
      }),
    );
    removed = [];
    setShowSubtaskAgents(true);
    setTeammateRemovalCallback((id) => {
      removed.push(id);
      agents.delete(id);
    });
  });

  afterEach(() => {
    for (const t of pollingTimers.values()) clearInterval(t);
    pollingTimers.clear();
    for (const w of fileWatchers.values()) w.close();
    fileWatchers.clear();
    setShowSubtaskAgents(false);
    setTeammateRemovalCallback(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('adopts a running fork once, named and linked to its lead, and never persists it', () => {
    const jsonl = seed('agent-arestarted-also-opening-34c5', forkMeta());
    scan();
    scan();
    expect(forks()).toHaveLength(1);
    const fork = forks()[0];
    expect(fork).toMatchObject({
      agentName: 'restarted-also-opening',
      leadAgentId: 1,
      sessionId: LEAD_SESSION,
      jsonlFile: jsonl,
      // The lead's project label.
      directoryName: 'PixelAgents',
      projectRoot: '/work/PixelAgents',
    });
    expect(fork.spawnToolUseId).toBeUndefined();
    expect(toPersistedAgent(fork)).toBeNull();
    // The office draws it as a subtask.
    expect(agentCreatedMessage(fork.id, fork)).toMatchObject({ isSubtask: true, parentAgentId: 1 });
  });

  it('removes the fork when its sidecar says finished', () => {
    seed('agent-afork-1', forkMeta());
    scan();
    const [fork] = forks();
    fs.writeFileSync(
      path.join(subagentsDir(), 'agent-afork-1.meta.json'),
      JSON.stringify(forkMeta(true)),
    );
    scan();
    expect(removed).toEqual([fork.id]);
    expect(forks()).toHaveLength(0);
  });

  it('removes a fork whose transcript is gone or silent too long', () => {
    const jsonl = seed('agent-afork-2', forkMeta());
    scan();
    // Silent for longer than FORK_STALE_MS: leaves, and is too old to come back.
    const old = (Date.now() - FORK_STALE_MS - 60_000) / 1000;
    fs.utimesSync(jsonl, old, old);
    scan();
    scan();
    expect(forks()).toHaveLength(0);

    seed('agent-afork-3', forkMeta());
    scan();
    fs.rmSync(path.join(subagentsDir(), 'agent-afork-3.jsonl'));
    scan();
    expect(forks()).toHaveLength(0);
    expect(removed).toHaveLength(2);
  });

  it('is off by default: nothing is adopted, and turning it off removes shown forks', () => {
    seed('agent-afork-off', forkMeta());
    setShowSubtaskAgents(false);
    scan();
    expect(forks()).toHaveLength(0);

    setShowSubtaskAgents(true);
    scan();
    const [fork] = forks();
    expect(fork).toBeDefined();
    setShowSubtaskAgents(false, agents);
    expect(removed).toEqual([fork.id]);
    expect(forks()).toHaveLength(0);
    scan();
    expect(forks()).toHaveLength(0);
  });

  it('skips finished forks, old forks, and helpers started by a tool call', () => {
    seed('agent-adone', forkMeta(true));
    seed('agent-aold', forkMeta(), FORK_ADOPT_RECENT_MS + 60_000);
    seed('agent-aexplore', {
      agentType: 'Explore',
      description: 'Map things',
      toolUseId: 'toolu_01abc',
      spawnDepth: 1,
    });
    scan();
    expect(forks()).toHaveLength(0);
    expect(agents.size).toBe(1);
  });
});
