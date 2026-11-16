/**
 * Uncommitted changes per project, for the agents working in it: the files,
 * insertions and deletions `git diff --shortstat HEAD` reports (tracked files
 * only). Read-only: `--no-optional-locks` keeps git from refreshing the index
 * under a running agent. Checked every 15 s for the projects in the office.
 *
 * Counts only, but they describe the operator's work: tokened sockets only
 * (usageLimits.ts PRIVILEGED_BROADCAST_TYPES).
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WorkingTreeChanges } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';

const WORKING_TREE_CHECK_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;

export interface ShortStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** Parse ` 3 files changed, 10 insertions(+), 2 deletions(-)`; empty output is a clean tree. */
export function parseShortStat(out: string): ShortStat {
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return {
    files: n(/(\d+) files? changed/),
    insertions: n(/(\d+) insertions?\(\+\)/),
    deletions: n(/(\d+) deletions?\(-\)/),
  };
}

function shortStat(root: string): Promise<ShortStat | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', root, 'diff', '--shortstat', 'HEAD'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : parseShortStat(String(stdout))),
    );
  });
}

let latest: WorkingTreeChanges | undefined;

/** The last workingTreeChanges sent, for a newly connected privileged client. */
export function workingTreeSnapshot(): WorkingTreeChanges | undefined {
  return latest;
}

export function startWorkingTree(store: AgentStateStore): { dispose(): void } {
  if (process.env.PIXEL_AGENTS_GIT_CHANGES === '0') return { dispose() {} };
  let busy = false;
  let sent = '';
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const roots = new Map<string, number[]>();
      for (const [id, agent] of store) {
        const root = agent.projectRoot;
        if (!root || !fs.existsSync(path.join(root, '.git'))) continue;
        roots.set(root, [...(roots.get(root) ?? []), id]);
      }
      const agents: WorkingTreeChanges['agents'] = [];
      for (const [root, ids] of roots) {
        const stat = await shortStat(root);
        if (!stat) continue;
        for (const id of ids) agents.push({ id, ...stat });
      }
      const message: WorkingTreeChanges = { type: 'workingTreeChanges', agents };
      const json = JSON.stringify(message);
      if (json !== sent) {
        sent = json;
        latest = message;
        store.broadcast({ ...message });
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), WORKING_TREE_CHECK_MS);
  timer.unref();
  void tick();
  return { dispose: () => clearInterval(timer) };
}
