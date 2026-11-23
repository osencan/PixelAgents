/**
 * Local read-only Gemini CLI adapter. Never writes under ~/.gemini or
 * forwards content: of each message it keeps the type and its tool names.
 *
 * Gemini keeps a project folder per working directory under ~/.gemini/tmp
 * (a readable slug, or the sha256 of the path in older versions), with the
 * sessions in `chats/`:
 * - `session-*.json`: one document `{ sessionId, kind, lastUpdated, messages }`,
 *   rewritten whole on every update (the CLI's ChatRecordingService).
 * - `session-*.jsonl`: a header line `{ sessionId, kind, lastUpdated, ... }`,
 *   then whole messages and `{ "$set": { lastUpdated?, messages? } }` patches.
 * A tool call is recorded only once it has finished, so a running tool shows
 * as the turn's previous step.
 */
import { createHash } from 'node:crypto';
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

/** A `.json` session larger than this is not parsed. */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

interface GeminiMessage {
  type: string;
  tools: string[];
}
export interface GeminiSession extends ObservedSession {
  /** Messages in order, by id: only their type and tool names. */
  messages: Map<string, GeminiMessage>;
}
export function emptyGeminiSession(): GeminiSession {
  return { ...emptyObservedSession(), messages: new Map() };
}

function geminiHome(): string {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

export function toolCategory(name: string): ObservedCategory {
  if (
    /^(read_file|read_many_files|glob|search_file_content|grep|list_directory|ls|web_fetch|google_web_search)$/.test(
      name,
    )
  )
    return 'reading';
  if (/^(replace|write_file|edit)$/.test(name)) return 'editing';
  if (name === 'run_shell_command') return 'running';
  return 'tool';
}

function touch(s: GeminiSession, value: unknown): void {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isFinite(at)) s.updated = Math.max(s.updated, at);
}

function addMessage(s: GeminiSession, m: unknown): void {
  if (!m || typeof m !== 'object') return;
  const r = m as Record<string, unknown>;
  if (typeof r.type !== 'string') return;
  const tools = Array.isArray(r.toolCalls)
    ? r.toolCalls.flatMap((t) =>
        t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'
          ? [(t as { name: string }).name]
          : [],
      )
    : [];
  const id = typeof r.id === 'string' ? r.id : `#${s.messages.size}`;
  s.messages.set(id, { type: r.type, tools });
  touch(s, r.timestamp);
}

/** Phase and category from the conversation's last user or model message. */
function derive(s: GeminiSession): void {
  let last: GeminiMessage | undefined;
  for (const m of s.messages.values()) {
    if (m.type === 'user') s.seenTurn = true;
    if (m.type === 'user' || m.type === 'gemini') last = m;
  }
  if (!last || !s.seenTurn) {
    s.phase = 'idle';
    s.category = 'thinking';
  } else if (last.type === 'user') {
    s.phase = 'active';
    s.category = 'thinking';
  } else if (last.tools.length) {
    // The model asked for tools; with their results it is called again.
    s.phase = 'active';
    s.category = toolCategory(last.tools.at(-1)!);
  } else {
    s.phase = 'idle';
    s.category = 'thinking';
  }
}

function applyHeader(s: GeminiSession, r: Record<string, unknown>): void {
  if (r.kind === 'subagent') s.subagent = true;
  touch(s, r.lastUpdated);
  touch(s, r.startTime);
}

/** Reduce one JSONL line: the header, a whole message, or a `$set` patch. */
export function reduceGeminiLine(s: GeminiSession, record: unknown): void {
  if (!record || typeof record !== 'object') return;
  const r = record as Record<string, unknown>;
  const set = r.$set;
  if (set && typeof set === 'object') {
    const patch = set as Record<string, unknown>;
    if (Array.isArray(patch.messages)) {
      s.messages.clear();
      for (const m of patch.messages) addMessage(s, m);
    }
    touch(s, patch.lastUpdated);
  } else if (typeof r.sessionId === 'string' && r.type === undefined) {
    applyHeader(s, r);
  } else {
    addMessage(s, r);
  }
  derive(s);
}

/** Reduce a whole `.json` session document. */
export function reduceGeminiDocument(s: GeminiSession, doc: unknown): void {
  if (!doc || typeof doc !== 'object') return;
  const r = doc as Record<string, unknown>;
  applyHeader(s, r);
  s.messages.clear();
  if (Array.isArray(r.messages)) for (const m of r.messages) addMessage(s, m);
  derive(s);
}

/** A `.json` session: re-read whole whenever its size or mtime changes. */
class GeminiDocumentReader implements SessionReader {
  session: GeminiSession = emptyGeminiSession();
  private key = '';
  constructor(private readonly identity: Pick<ObservedSession, 'id' | 'cwd'>) {
    Object.assign(this.session, identity);
  }
  async read(file: string): Promise<void> {
    const stat = await fs.stat(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (key === this.key || stat.size > MAX_DOCUMENT_BYTES) return;
    // A file caught mid-write fails to parse; the next poll reads it again.
    const doc: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    this.key = key;
    const s = emptyGeminiSession();
    Object.assign(s, this.identity);
    reduceGeminiDocument(s, doc);
    this.session = s;
  }
}

/** The project folder a session file sits in: `<tmp>/<project>/chats/<file>`. */
function projectFolder(file: string): string {
  return path.dirname(path.dirname(file));
}

/**
 * The working directory a project folder belongs to: its `.project_root`, or
 * the `projects.json` entry naming the folder (by slug, or by the sha256 of
 * the path that older versions named folders after).
 */
export async function geminiProjectCwd(folder: string, home = geminiHome()): Promise<string> {
  try {
    const root = (await fs.readFile(path.join(folder, '.project_root'), 'utf8')).trim();
    if (path.isAbsolute(root)) return root;
  } catch {
    /* Older project folders have no .project_root. */
  }
  const name = path.basename(folder);
  try {
    const registry = JSON.parse(await fs.readFile(path.join(home, 'projects.json'), 'utf8'));
    const projects: unknown = registry?.projects;
    if (projects && typeof projects === 'object')
      for (const [cwd, slug] of Object.entries(projects as Record<string, unknown>))
        if (slug === name || createHash('sha256').update(cwd).digest('hex') === name) return cwd;
  } catch {
    /* No registry: the session stays out of the office. */
  }
  return '';
}

async function sessionFiles(): Promise<string[]> {
  const tmp = path.join(geminiHome(), 'tmp');
  const result: string[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(tmp);
  } catch {
    return result; // Gemini CLI not installed or never run.
  }
  for (const project of projects) {
    const chats = path.join(tmp, project, 'chats');
    try {
      for (const name of await fs.readdir(chats))
        if (/^session-.*\.jsonl?$/.test(name)) result.push(path.join(chats, name));
    } catch {
      /* A project folder without chats. */
    }
  }
  return result;
}

/**
 * A reader that learns the session's cwd on first read. Identity is the file
 * (`<project>/<file name>`), not the logged sessionId: a resumed session keeps
 * writing its file, and some writers log one sessionId for every session.
 */
class GeminiReader implements SessionReader {
  private inner?: SessionReader;
  constructor(private readonly file: string) {}
  get session(): ObservedSession {
    return this.inner?.session ?? emptyGeminiSession();
  }
  async read(file: string): Promise<void> {
    if (!this.inner) {
      const folder = projectFolder(this.file);
      const identity = {
        id: `${path.basename(folder)}/${path.basename(this.file).replace(/\.jsonl?$/, '')}`,
        cwd: await geminiProjectCwd(folder),
      };
      if (this.file.endsWith('.jsonl')) {
        const fresh = () => Object.assign(emptyGeminiSession(), identity);
        this.inner = new JsonlTail<GeminiSession>(fresh, reduceGeminiLine);
      } else {
        this.inner = new GeminiDocumentReader(identity);
      }
    }
    await this.inner.read(file);
  }
}

export const geminiObserver: SessionObserver = {
  providerId: 'gemini',
  displayName: 'Gemini',
  disableEnv: 'PIXEL_AGENTS_GEMINI',
  // Gemini logs a tool only once it finishes and some writers log no replies,
  // so a turn that goes quiet this long is shown as waiting, not working forever.
  staleActiveMs: 10 * 60_000,
  listFiles: sessionFiles,
  createReader: (file) => new GeminiReader(file),
};
