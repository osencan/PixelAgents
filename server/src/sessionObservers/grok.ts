/**
 * Local read-only Grok Build (xAI's `grok`) adapter. Never writes under
 * ~/.grok or forwards content: of each update it keeps the kind, a tool's id,
 * kind and status, and the time.
 *
 * Sessions live in `~/.grok/sessions/<url-encoded cwd>/<session id>/`, the
 * log being `updates.jsonl`: append-only ACP `session/update` notifications
 * (`params.update.sessionUpdate`), truncated by `/rewind`. The session's cwd
 * is in its `summary.json`, else in the project folder's `.cwd` (long paths
 * get a hashed folder name), else the folder name itself.
 *
 * Written from xAI's documentation and the ACP schema, not from real logs:
 * it accepts the update bare, under `update`, or under `params.update`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { JsonlTail } from './jsonlTail.js';
import type {
  ObservedCategory,
  ObservedSession,
  SessionObserver,
  SessionReader,
} from './observer.js';
import { emptyObservedSession } from './observer.js';

const LOG_NAME = 'updates.jsonl';

export interface GrokSession extends ObservedSession {
  /** Tools in flight, by tool call id. */
  tools: Map<string, ObservedCategory>;
}
export function emptyGrokSession(): GrokSession {
  return { ...emptyObservedSession(), tools: new Map() };
}

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

/** ACP's tool kinds. */
export function toolCategory(kind: unknown): ObservedCategory {
  if (kind === 'read' || kind === 'search' || kind === 'fetch') return 'reading';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'editing';
  if (kind === 'execute') return 'running';
  if (kind === 'think') return 'thinking';
  return 'tool';
}

const FINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TURN_ENDS = new Set(['turn_completed', 'turn_cancelled', 'turn_failed']);

function updateOf(r: Record<string, any>): Record<string, any> | undefined {
  const u = r.params?.update ?? r.update ?? r;
  return u && typeof u === 'object' && typeof u.sessionUpdate === 'string' ? u : undefined;
}

export function reduceGrokRecord(s: GrokSession, record: unknown): void {
  if (!record || typeof record !== 'object') return;
  const r = record as Record<string, any>;
  const u = updateOf(r);
  if (!u) return;
  const at = Date.parse(r.timestamp ?? r.params?._meta?.timestamp ?? u.timestamp);
  if (Number.isFinite(at)) s.updated = Math.max(s.updated, at);
  const kind: string = u.sessionUpdate;
  if (TURN_ENDS.has(kind)) {
    s.seenTurn = true;
    s.phase = 'idle';
    s.tools.clear();
    s.category = 'thinking';
  } else if (kind === 'user_message_chunk') {
    s.seenTurn = true;
    s.phase = 'active';
    s.tools.clear();
    s.category = 'thinking';
  } else if (kind === 'tool_call') {
    s.seenTurn = true;
    s.phase = 'active';
    const id = String(u.toolCallId ?? 'tool');
    if (FINAL_TOOL_STATUSES.has(u.status)) s.tools.delete(id);
    else s.tools.set(id, toolCategory(u.kind));
    s.category = [...s.tools.values()].at(-1) ?? 'thinking';
  } else if (kind === 'tool_call_update') {
    const id = String(u.toolCallId ?? 'tool');
    if (FINAL_TOOL_STATUSES.has(u.status)) s.tools.delete(id);
    else if (u.kind !== undefined && s.tools.has(id)) s.tools.set(id, toolCategory(u.kind));
    if (s.phase === 'active') s.category = [...s.tools.values()].at(-1) ?? 'thinking';
  } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    if (s.phase === 'active' && !s.tools.size) s.category = 'thinking';
  }
}

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The cwd of a session folder `<sessions>/<project>/<id>` (see the header). */
export async function grokSessionCwd(sessionDir: string): Promise<string> {
  const summary = await readJson(path.join(sessionDir, 'summary.json'));
  if (typeof summary?.cwd === 'string' && path.isAbsolute(summary.cwd)) return summary.cwd;
  const project = path.dirname(sessionDir);
  try {
    const cwd = (await fs.readFile(path.join(project, '.cwd'), 'utf8')).trim();
    if (path.isAbsolute(cwd)) return cwd;
  } catch {
    /* Only long paths get a .cwd file. */
  }
  try {
    const decoded = decodeURIComponent(path.basename(project));
    if (path.isAbsolute(decoded)) return decoded;
  } catch {
    /* Not URL-encoded. */
  }
  return '';
}

/** Every updates.jsonl under `dir`, a session's subagents included. */
async function logsUnder(dir: string, depth: number, out: string[]): Promise<void> {
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Grok Build not installed or never run.
  }
  for (const item of items) {
    const p = path.join(dir, item.name);
    if (item.isFile() && item.name === LOG_NAME) out.push(p);
    else if (item.isDirectory() && depth > 0) await logsUnder(p, depth - 1, out);
  }
}

/**
 * Reads one session log. The session folder is the log's directory; a log
 * under `<session>/subagents/` is that session's subagent.
 */
class GrokReader implements SessionReader {
  private inner?: JsonlTail<GrokSession>;
  constructor(private readonly file: string) {}
  get session(): ObservedSession {
    return this.inner?.session ?? emptyGrokSession();
  }
  async read(file: string): Promise<void> {
    if (!this.inner) {
      const dir = path.dirname(this.file);
      const parts = dir.split(path.sep);
      const sub = parts.lastIndexOf('subagents');
      const sessionDir = sub > 0 ? parts.slice(0, sub).join(path.sep) : dir;
      const identity = {
        id: sub > 0 ? `${path.basename(sessionDir)}/${path.basename(dir)}` : path.basename(dir),
        cwd: await grokSessionCwd(sessionDir),
        ...(sub > 0 ? { parent: path.basename(sessionDir) } : {}),
      };
      this.inner = new JsonlTail<GrokSession>(
        () => Object.assign(emptyGrokSession(), identity),
        reduceGrokRecord,
      );
    }
    await this.inner.read(file);
    // Records may carry no time: the log's own mtime then dates the session.
    const { mtimeMs } = await fs.stat(file);
    this.inner.session.updated = Math.max(this.inner.session.updated, mtimeMs);
  }
}

export const grokObserver: SessionObserver = {
  providerId: 'grok',
  displayName: 'Grok',
  disableEnv: 'PIXEL_AGENTS_GROK',
  // Older versions log no turn end; a turn silent this long shows as waiting.
  staleActiveMs: 10 * 60_000,
  // sessions/<project>/<session>/updates.jsonl, subagents up to two levels below.
  listFiles: async () => {
    const out: string[] = [];
    await logsUnder(path.join(grokHome(), 'sessions'), 4, out);
    return out;
  },
  createReader: (file) => new GrokReader(file),
};
