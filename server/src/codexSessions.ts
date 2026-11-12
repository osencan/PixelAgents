/** Local read-only Codex rollout adapter. Never writes to CODEX_HOME or forwards content. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';

export interface CodexSession {
  id: string;
  cwd: string;
  parent?: string;
  phase: 'active' | 'idle';
  activity: string;
  reading: boolean;
  seenTurn: boolean;
  updated: number;
  tools: Map<string, { activity: string; reading: boolean }>;
}
export function emptyCodexSession(): CodexSession {
  return {
    id: '',
    cwd: '',
    phase: 'idle',
    activity: '',
    reading: false,
    seenTurn: false,
    updated: 0,
    tools: new Map(),
  };
}
function toolActivity(name: string): { activity: string; reading: boolean } {
  if (/read|search|find|list|browse|web|view|fetch/i.test(name))
    return { activity: 'Codex: reading / searching', reading: true };
  if (/patch|edit|write_file/i.test(name)) return { activity: 'Codex: editing', reading: false };
  if (/exec|shell|command|stdin/i.test(name))
    return { activity: 'Codex: running a command', reading: false };
  return { activity: 'Codex: using a tool', reading: false };
}
/** Consume only metadata and event types, never prompt/tool arguments or tool results. */
export function reduceCodexRecord(s: CodexSession, record: unknown): void {
  if (!record || typeof record !== 'object') return;
  const r = record as Record<string, any>;
  const p = r.payload;
  if (!p || typeof p !== 'object') return;
  const at = Date.parse(r.timestamp);
  const touch = () => {
    if (Number.isFinite(at)) s.updated = Math.max(s.updated, at);
  };
  if (r.type === 'session_meta') {
    if (typeof (p.id ?? p.session_id) === 'string') s.id = p.id ?? p.session_id;
    if (typeof p.cwd === 'string') s.cwd = p.cwd;
    if (typeof p.parent_thread_id === 'string') s.parent = p.parent_thread_id;
    return;
  }
  if (r.type === 'turn_context') {
    if (typeof p.cwd === 'string') s.cwd = p.cwd;
    return;
  }
  if (r.type === 'event_msg') {
    if (p.type === 'task_started' || p.type === 'turn_started') {
      s.seenTurn = true;
      s.phase = 'active';
      s.tools.clear();
      s.activity = 'Codex: working';
      s.reading = false;
      touch();
    } else if (
      [
        'task_complete',
        'task_completed',
        'turn_complete',
        'turn_completed',
        'turn_aborted',
      ].includes(p.type)
    ) {
      s.seenTurn = true;
      s.phase = 'idle';
      s.tools.clear();
      s.activity = '';
      touch();
    }
    return;
  }
  if (r.type !== 'response_item') return;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    s.seenTurn = true;
    s.phase = 'active';
    const activity = toolActivity(typeof p.name === 'string' ? p.name : '');
    s.tools.set(String(p.call_id ?? p.id ?? 'tool'), activity);
    Object.assign(s, activity);
    touch();
  } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    s.tools.delete(String(p.call_id ?? p.id ?? 'tool'));
    const latest = [...s.tools.values()].at(-1);
    if (s.phase === 'active')
      Object.assign(s, latest ?? { activity: 'Codex: working', reading: false });
    touch();
  } else if (p.type === 'reasoning' || (p.type === 'message' && p.role === 'assistant')) {
    if (s.phase === 'active') {
      s.activity = s.tools.size ? s.activity : 'Codex: working';
      touch();
    }
  }
}

export class CodexTail {
  offset = 0;
  pending = Buffer.alloc(0);
  session = emptyCodexSession();
  private inode = 0;
  async read(file: string): Promise<void> {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if ((this.inode && stat.ino !== this.inode) || stat.size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.session = emptyCodexSession();
      }
      this.inode = stat.ino;
      // Fixed snapshot prevents a busy session from holding this poll open forever.
      const end = stat.size;
      while (this.offset < end) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, end - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let start = 0,
          newline: number;
        while ((newline = data.indexOf(10, start)) !== -1) {
          try {
            reduceCodexRecord(
              this.session,
              JSON.parse(data.subarray(start, newline).toString('utf8')),
            );
          } catch {
            /* A malformed line must not break subsequent events. */
          }
          start = newline + 1;
        }
        this.pending = Buffer.from(data.subarray(start));
        if (this.pending.length > 32 * 1024 * 1024) this.pending = Buffer.alloc(0);
      }
    } finally {
      await handle.close();
    }
  }
}

const RECENT_MS = 5 * 60_000;
const EXPIRE_MS = 30 * 60_000;
export class CodexOfficeBridge {
  private tracked = new Map<string, { id: number; signature: string }>();
  constructor(private store: AgentStateStore) {}
  sync(s: CodexSession, now = Date.now()): void {
    if (!s.id || !s.cwd || !s.seenTurn) return;
    let entry = this.tracked.get(s.id);
    if (now - s.updated > EXPIRE_MS) {
      this.remove(s.id);
      return;
    }
    // Do not fill the office with historical sessions on startup.
    if (!entry && now - s.updated > RECENT_MS) return;
    if (entry && !this.store.has(entry.id)) {
      this.tracked.delete(s.id);
      entry = undefined;
    }
    if (!entry) {
      const id = this.store.nextAgentId.current++;
      const agent = createAgentState({
        id,
        sessionId: `codex:${s.id}`,
        projectDir: s.cwd,
        jsonlFile: '',
        isExternal: true,
        hooksOnly: true,
        hookDelivered: true,
        providerId: 'codex',
        directoryName: `Codex · ${path.basename(s.cwd) || s.cwd}${s.parent ? ' · subagent' : ''}`,
        lastDataAt: s.updated,
      });
      assignPaletteIfNeeded(agent, this.store);
      this.store.set(id, agent);
      entry = { id, signature: '' };
      this.tracked.set(s.id, entry);
    }
    const agent = this.store.get(entry.id)!;
    agent.lastDataAt = s.updated;
    const signature = JSON.stringify([s.phase, s.activity, s.reading]);
    if (signature === entry.signature) return;
    entry.signature = signature;
    agent.activeToolIds.clear();
    agent.activeToolNames.clear();
    agent.activeToolStatuses.clear();
    agent.turnActive = s.phase === 'active';
    agent.isWaiting = !agent.turnActive;
    this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
    if (agent.turnActive) {
      const toolId = `codex-activity-${agent.id}`;
      // Existing renderer taxonomy: Read gets the reading animation; Edit gets typing.
      const toolName = s.reading ? 'Read' : 'Edit';
      agent.activeToolIds.add(toolId);
      agent.activeToolNames.set(toolId, toolName);
      agent.activeToolStatuses.set(toolId, s.activity);
      this.store.broadcast({
        type: 'agentToolStart',
        id: agent.id,
        toolId,
        toolName,
        status: s.activity,
      });
    }
    this.store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status: agent.turnActive ? 'active' : 'waiting',
      awaitingInput: false,
    });
  }
  remove(sessionId: string): void {
    const entry = this.tracked.get(sessionId);
    if (entry) this.store.delete(entry.id);
    this.tracked.delete(sessionId);
  }
  dispose(): void {
    for (const id of this.tracked.keys()) this.remove(id);
  }
}

async function rolloutFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  try {
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name);
      if (item.isDirectory()) result.push(...(await rolloutFiles(file)));
      else if (item.isFile() && item.name.endsWith('.jsonl')) result.push(file);
    }
  } catch {
    /* Missing/unreadable directories are normal when Codex is not installed. */
  }
  return result;
}
/** Independent observer; it never starts, stops, resumes or sends commands to Codex. */
export function startCodexSessions(store: AgentStateStore): { dispose(): void } {
  if (process.env.PIXEL_AGENTS_CODEX === '0') return { dispose() {} };
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const bridge = new CodexOfficeBridge(store);
  const tails = new Map<string, CodexTail>();
  const baseline = new Map<string, number>();
  let stopped = false,
    polling = false,
    nextScan = 0;
  let files: string[] = [];
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (Date.now() >= nextScan) {
        files = await rolloutFiles(root);
        nextScan = Date.now() + 5000;
        const present = new Set(files);
        for (const [file, tail] of tails)
          if (!present.has(file)) {
            bridge.remove(tail.session.id);
            tails.delete(file);
            baseline.delete(file);
          }
      }
      for (const file of files) {
        if (stopped) break;
        try {
          const stat = await fs.stat(file);
          let tail = tails.get(file);
          const previous = baseline.get(file);
          baseline.set(file, stat.size);
          if (!tail) {
            if (
              Date.now() - stat.mtimeMs > RECENT_MS &&
              (previous === undefined || previous === stat.size)
            )
              continue;
            tail = new CodexTail();
            tails.set(file, tail);
          }
          await tail.read(file);
          if (!stopped) bridge.sync(tail.session);
        } catch {
          /* One disappearing or unreadable rollout must not break other sessions. */
        }
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), 1000);
  timer.unref();
  void poll();
  console.log('[Pixel Agents] Codex read-only session detection enabled');
  return {
    dispose() {
      stopped = true;
      clearInterval(timer);
      bridge.dispose();
    },
  };
}
