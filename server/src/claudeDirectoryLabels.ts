/**
 * Project labels for Claude and Codex characters. Claude may keep a rollout in
 * its original project folder after changing cwd, so its label follows the
 * transcript's latest top-level cwd; Codex reports cwd through its observer.
 * Labels are metadata: they never merge or reassign characters.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentStateStore } from './agentStateStore.js';
import { projectDisplayNames, resolveProject } from './projectIdentity.js';
import { readProjectLabels } from './projectLabels.js';
import type { AgentState } from './types.js';

const CODEX_LABEL_PREFIX = 'Codex · ';
const CODEX_SUBAGENT_SUFFIX = ' · subagent';

export function projectNameForCwd(cwd: string): string | undefined {
  return resolveProject(cwd)?.name;
}

/** The label shown for an agent whose project displays as `name`. */
function labelFor(agent: AgentState, name: string): string {
  if (agent.providerId !== 'codex') return name;
  const sub = agent.directoryName?.endsWith(CODEX_SUBAGENT_SUFFIX) ? CODEX_SUBAGENT_SUFFIX : '';
  return `${CODEX_LABEL_PREFIX}${name}${sub}`;
}

/** Read backwards in bounded chunks, without parsing prompts or nested tool output as cwd. */
export function latestClaudeCwd(file: string, sessionId?: string): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    let suffix = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - 65536);
      const chunk = Buffer.alloc(end - start);
      const read = fs.readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk.subarray(0, read), suffix]);
      const first = start === 0 ? 0 : data.indexOf(10) + 1;
      if (first > 0 || start === 0) {
        const lines = data.subarray(first).toString('utf8').split('\n');
        // The trailing fragment may be an in-progress write; only newline-terminated records count.
        lines.pop();
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const record = JSON.parse(lines[i]);
            if (
              record.isSidechain ||
              (sessionId && record.sessionId && record.sessionId !== sessionId)
            )
              continue;
            if (typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) return record.cwd;
          } catch {
            /* malformed records do not prevent finding earlier metadata */
          }
        }
      }
      suffix = first > 0 ? data.subarray(0, first) : data;
      // Bound memory for unusually large records; earlier complete metadata is still usable.
      if (suffix.length > 8 * 1024 * 1024) suffix = Buffer.alloc(0);
      end = start;
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

export function startClaudeDirectoryLabels(store: AgentStateStore): { dispose(): void } {
  // Per Claude agent: the transcript state last read, and the cwd it gave.
  const checked = new Map<number, { key: string; cwd?: string }>();
  // The worktree each agent's last label broadcast carried.
  const sentWorktree = new Map<number, string | undefined>();
  const cwdFor = (id: number, agent: AgentState): string | undefined => {
    if (agent.providerId === 'codex') return agent.projectCwd;
    if (!agent.jsonlFile) return undefined;
    const stat = fs.statSync(agent.jsonlFile);
    const key = `${agent.jsonlFile}:${stat.size}:${stat.mtimeMs}`;
    const cached = checked.get(id);
    if (cached?.key === key) return cached.cwd;
    const cwd = latestClaudeCwd(agent.jsonlFile, agent.sessionId);
    checked.set(id, { key, cwd });
    return cwd;
  };
  const refresh = () => {
    const labelled: Array<[number, AgentState]> = [];
    for (const [id, agent] of store) {
      // Teammates are labelled by their lead.
      if (agent.leadAgentId !== undefined) continue;
      try {
        const cwd = cwdFor(id, agent);
        const project = cwd ? resolveProject(cwd) : undefined;
        if (project) {
          agent.projectRoot = project.root;
          agent.projectWorktree = project.worktree;
        }
      } catch {
        /* missing or rotating logs are retried on the next poll */
      }
      if (agent.projectRoot) labelled.push([id, agent]);
    }
    const names = projectDisplayNames(labelled.map(([, agent]) => agent.projectRoot!));
    const pinned = readProjectLabels();
    let changed = false;
    for (const [id, agent] of labelled) {
      const root = agent.projectRoot!;
      const name = labelFor(agent, pinned[root] ?? names.get(root)!);
      const worktree = agent.projectWorktree;
      if (name === agent.directoryName && worktree === sentWorktree.get(id)) continue;
      agent.directoryName = name;
      sentWorktree.set(id, worktree);
      store.broadcast({ type: 'agentDirectoryChanged', id, directoryName: name, worktree });
      changed = true;
    }
    if (changed) store.persist();
    for (const id of checked.keys()) if (!store.has(id)) checked.delete(id);
    for (const id of sentWorktree.keys()) if (!store.has(id)) sentWorktree.delete(id);
  };
  const timer = setInterval(refresh, 2000);
  timer.unref();
  refresh();
  return {
    dispose() {
      clearInterval(timer);
    },
  };
}
