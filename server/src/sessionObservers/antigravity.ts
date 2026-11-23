/**
 * Local read-only Antigravity adapter (Google's agent IDE, its 2.0 app and
 * its CLI, all running Gemini). Never writes under ~/.gemini or forwards
 * content: of each step it keeps the type, its tool names and the time.
 *
 * Each product keeps its data in `~/.gemini/<product>/` (`antigravity-ide`,
 * `antigravity`, `antigravity-cli`):
 * - `brain/<conversation id>/.system_generated/logs/transcript.jsonl`: one
 *   step per line, appended as the conversation runs (`step_index`, `source`,
 *   `type`, `status`, `created_at`, `content`, `tool_calls[{ name, args }]`).
 *   A turn is a `USER_INPUT`, then `PLANNER_RESPONSE` steps, each calling
 *   tools (logged when called, not when finished) whose results come back as
 *   `GENERIC` steps, until a response that calls none.
 * - `conversations/<conversation id>.db`: SQLite; the workspace folder is a
 *   `file://` URI in `trajectory_metadata_blob`. Read with `node:sqlite`
 *   (Node 22.5 and later): without it the folder is unknown and the
 *   conversation is not shown.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolCategory as geminiToolCategory } from './gemini.js';
import { JsonlTail } from './jsonlTail.js';
import type {
  ObservedCategory,
  ObservedSession,
  SessionObserver,
  SessionReader,
} from './observer.js';
import { emptyObservedSession } from './observer.js';

const PRODUCTS = ['antigravity-ide', 'antigravity', 'antigravity-cli'];
const TRANSCRIPT = path.join('.system_generated', 'logs', 'transcript.jsonl');

export function emptyAntigravitySession(): ObservedSession {
  return emptyObservedSession();
}

/**
 * The IDE names tools after their step types, lower-cased
 * (`CORTEX_STEP_TYPE_VIEW_FILE` → `view_file`); the 2.0 app also uses Gemini
 * CLI's names (`read_file`).
 */
export function toolCategory(name: string): ObservedCategory {
  if (
    /^(view_file|view_file_outline|view_code_item|view_content_chunk|list_dir|list_directory|grep_search|find_by_name|codebase_search|code_search|find|read_url_content|search_web|read_resource|read_terminal|read_notebook)$/.test(
      name,
    )
  )
    return 'reading';
  if (
    /^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|edit_notebook|move)$/.test(
      name,
    )
  )
    return 'editing';
  if (/^(run_command|shell_exec|command_status|send_command_input)$/.test(name)) return 'running';
  return geminiToolCategory(name);
}

/** Tools that only update the agent's task list and focus (seen in the 2.0 app). */
const PLANNING_TOOLS = new Set(['update_steps', 'update_focus', 'manage_task', 'task_boundary']);

export function reduceAntigravityStep(s: ObservedSession, record: unknown): void {
  if (!record || typeof record !== 'object') return;
  const r = record as Record<string, any>;
  if (typeof r.type !== 'string') return;
  const at = Date.parse(r.created_at);
  if (Number.isFinite(at)) s.updated = Math.max(s.updated, at);
  if (r.type === 'USER_INPUT') {
    s.seenTurn = true;
    s.phase = 'active';
    s.category = 'thinking';
  } else if (r.type === 'PLANNER_RESPONSE') {
    const tools: string[] = Array.isArray(r.tool_calls)
      ? r.tool_calls.map((t: any) => t?.name).filter((n: unknown) => typeof n === 'string')
      : [];
    if (tools.length) {
      s.seenTurn = true;
      s.phase = 'active';
      // The agent's own planning tools do no work: the step's category is its last real tool.
      const work = tools.filter((n) => !PLANNING_TOOLS.has(n)).at(-1);
      s.category = work === undefined ? 'thinking' : toolCategory(work);
    } else if (r.content !== undefined || r.thinking !== undefined) {
      // A reply that calls no tool ends the turn.
      s.phase = 'idle';
      s.category = 'thinking';
    }
    // An empty response is an attempt the API refused (an error step follows
    // and the planner retries): the turn goes on.
  }
  // Tool results (GENERIC), errors and system steps change nothing.
}

type Sqlite = typeof import('node:sqlite');

/** What the server logs, once, when it can't read a conversation's database. */
export function sqliteMissingWarning(nodeVersion: string): string {
  return (
    `[Pixel Agents] Antigravity conversations found but not shown: finding their folder ` +
    `needs Node 22.5 or later (Node ${nodeVersion} is running; on 22.5 to 22.12 start ` +
    `with --experimental-sqlite). Update Node to see them in the office.`
  );
}

let sqliteMissingWarned = false;

/**
 * The workspace folder a conversation runs in, from its database (see the
 * header). Without node:sqlite it is unknown: the conversation is skipped,
 * and the server says why once instead of showing nothing silently.
 */
export async function antigravityWorkspace(
  dbFile: string,
  loadSqlite: () => Promise<Sqlite> = () => import('node:sqlite'),
): Promise<string> {
  let sqlite: Sqlite;
  try {
    sqlite = await loadSqlite();
  } catch {
    if (!sqliteMissingWarned) {
      sqliteMissingWarned = true;
      console.warn(sqliteMissingWarning(process.version));
    }
    return '';
  }
  try {
    await fs.access(dbFile);
  } catch {
    return '';
  }
  const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM trajectory_metadata_blob').get() as
      { data?: Uint8Array } | undefined;
    if (!row?.data) return '';
    const data = Buffer.from(row.data);
    // A protobuf string: its length is the varint just before it.
    const start = data.indexOf('file:///');
    let from = start - 1;
    while (from > 0 && data[from - 1] & 0x80) from--;
    if (from < 0) return '';
    let length = 0;
    for (let i = start - 1; i >= from; i--) length = length * 128 + (data[i] & 0x7f);
    const uri = data.subarray(start, start + length).toString('utf8');
    const cwd = fileURLToPath(uri);
    return path.isAbsolute(cwd) ? cwd : '';
  } catch {
    return '';
  } finally {
    db.close();
  }
}

/** Reads one transcript; its conversation's folder is looked up until found. */
class AntigravityReader implements SessionReader {
  private readonly tail: JsonlTail<ObservedSession>;
  private readonly dbFile: string;
  private cwd = '';
  constructor(file: string) {
    // <product>/brain/<conversation>/.system_generated/logs/transcript.jsonl
    const conversation = path.resolve(file, '..', '..', '..');
    const product = path.resolve(conversation, '..', '..');
    const id = `${path.basename(product)}/${path.basename(conversation)}`;
    this.dbFile = path.join(product, 'conversations', `${path.basename(conversation)}.db`);
    this.tail = new JsonlTail<ObservedSession>(
      () => Object.assign(emptyAntigravitySession(), { id, cwd: this.cwd }),
      reduceAntigravityStep,
    );
  }
  get session(): ObservedSession {
    return this.tail.session;
  }
  async read(file: string): Promise<void> {
    if (!this.cwd) this.cwd = await antigravityWorkspace(this.dbFile);
    this.tail.session.cwd = this.cwd;
    await this.tail.read(file);
  }
}

export const antigravityObserver: SessionObserver = {
  providerId: 'antigravity',
  displayName: 'Antigravity',
  disableEnv: 'PIXEL_AGENTS_ANTIGRAVITY',
  // A conversation that stops on an API error logs no turn end.
  staleActiveMs: 10 * 60_000,
  listFiles: async () => {
    const out: string[] = [];
    for (const product of PRODUCTS) {
      const brain = path.join(os.homedir(), '.gemini', product, 'brain');
      let ids: string[];
      try {
        ids = await fs.readdir(brain);
      } catch {
        continue; // That product is not installed or never ran.
      }
      for (const id of ids) {
        const file = path.join(brain, id, TRANSCRIPT);
        try {
          if ((await fs.stat(file)).isFile()) out.push(file);
        } catch {
          /* A brain folder without a transcript (older versions). */
        }
      }
    }
    return out;
  },
  createReader: (file) => new AntigravityReader(file),
};
