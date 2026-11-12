/** Claude may keep a rollout in its original project folder after changing cwd. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentStateStore } from './agentStateStore.js';

export function projectNameForCwd(cwd: string): string | undefined {
  if (!path.isAbsolute(cwd)) return undefined;
  let dir = path.normalize(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir) || dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.basename(cwd) || cwd;
    dir = parent;
  }
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
  const checked = new Map<number, string>();
  const refresh = () => {
    for (const [id, agent] of store) {
      if (agent.providerId === 'codex' || !agent.jsonlFile || agent.leadAgentId !== undefined)
        continue;
      try {
        const stat = fs.statSync(agent.jsonlFile);
        const key = `${agent.jsonlFile}:${stat.size}:${stat.mtimeMs}`;
        if (checked.get(id) === key) continue;
        checked.set(id, key);
        const cwd = latestClaudeCwd(agent.jsonlFile, agent.sessionId);
        const name = cwd && projectNameForCwd(cwd);
        if (!name || name === agent.directoryName) continue;
        agent.directoryName = name;
        store.broadcast({ type: 'agentDirectoryChanged', id, directoryName: name });
        store.persist();
      } catch {
        /* missing or rotating logs are retried on the next poll */
      }
    }
    for (const id of checked.keys()) if (!store.has(id)) checked.delete(id);
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
