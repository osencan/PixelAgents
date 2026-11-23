/** Local read-only Codex rollout adapter. Never writes to CODEX_HOME or forwards content. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { JsonlTail } from './jsonlTail.js';
import type { ObservedCategory, ObservedSession, SessionObserver } from './observer.js';
import { emptyObservedSession } from './observer.js';

export interface CodexSession extends ObservedSession {
  /** Tools in flight, by call id: parallel calls finish in any order. */
  tools: Map<string, ObservedCategory>;
}
export function emptyCodexSession(): CodexSession {
  return { ...emptyObservedSession(), tools: new Map() };
}
function toolCategory(name: string): ObservedCategory {
  if (/read|search|find|list|browse|web|view|fetch/i.test(name)) return 'reading';
  if (/patch|edit|write_file/i.test(name)) return 'editing';
  if (/exec|shell|command|stdin/i.test(name)) return 'running';
  return 'tool';
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
      s.category = 'thinking';
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
      s.category = 'thinking';
      touch();
    }
    return;
  }
  if (r.type !== 'response_item') return;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    s.seenTurn = true;
    s.phase = 'active';
    s.category = toolCategory(typeof p.name === 'string' ? p.name : '');
    s.tools.set(String(p.call_id ?? p.id ?? 'tool'), s.category);
    touch();
  } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    s.tools.delete(String(p.call_id ?? p.id ?? 'tool'));
    if (s.phase === 'active') s.category = [...s.tools.values()].at(-1) ?? 'thinking';
    touch();
  } else if (p.type === 'reasoning' || (p.type === 'message' && p.role === 'assistant')) {
    if (s.phase === 'active') {
      if (!s.tools.size) s.category = 'thinking';
      touch();
    }
  }
}

export class CodexTail extends JsonlTail<CodexSession> {
  constructor() {
    super(emptyCodexSession, reduceCodexRecord);
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

export const codexObserver: SessionObserver = {
  providerId: 'codex',
  displayName: 'Codex',
  disableEnv: 'PIXEL_AGENTS_CODEX',
  listFiles: () =>
    rolloutFiles(
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    ),
  createReader: () => new CodexTail(),
};
