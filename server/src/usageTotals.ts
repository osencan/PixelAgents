/**
 * Tokens used today, per session and per project, read from the same local
 * logs the office already watches: Claude transcripts and Codex rollouts.
 *
 * Counts only, never content, and never a cost estimate (prices change and
 * plans differ). "Today" is the local calendar day of each record's timestamp.
 *
 * - Claude repeats one message's usage on every line of that message (and a
 *   streaming line can carry a partial count), so usage is keyed by
 *   `message.id`: the largest reading wins and an earlier one is backed out.
 *   The key is global, so a message copied into another file (resume, fork)
 *   still counts once.
 * - Codex logs running session totals (`token_count`); a record's usage is the
 *   difference from the previous total, credited to the model in effect.
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 *
 * Usage is the operator's account data: the message goes to privileged
 * sockets only (usageLimits.ts PRIVILEGED_BROADCAST_TYPES).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentUsageToday, ModelTokenCounts, UsageToday } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { projectDisplayNames, resolveProject } from './projectIdentity.js';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ModelCounts = ModelTokenCounts;

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** First read of a log starts at most this far from its end. */
export const USAGE_FIRST_READ_MAX_BYTES = 32 * 1024 * 1024;
/** One pass reads at most this much of one file; the rest waits a tick. */
export const USAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const USAGE_TICK_MS = 5_000;
const USAGE_SCAN_MS = 30_000;

/** Local calendar day (YYYY-MM-DD) of an epoch-ms time. */
export function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function add(into: TokenCounts, c: TokenCounts, sign = 1): void {
  into.input += sign * c.input;
  into.output += sign * c.output;
  into.cacheRead += sign * c.cacheRead;
  into.cacheWrite += sign * c.cacheWrite;
}

function total(c: TokenCounts): number {
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

/** Today's counts for one session, split by model. */
export class SessionUsage {
  /** day -> model -> counts */
  readonly byDay = new Map<string, Map<string, TokenCounts>>();
  compactions = 0;
  /** Context window the log states (Codex); Claude logs state none. */
  contextWindow?: number;
  cwd?: string;

  bucket(day: string, model: string): TokenCounts {
    let models = this.byDay.get(day);
    if (!models) this.byDay.set(day, (models = new Map()));
    let c = models.get(model);
    if (!c) models.set(model, (c = { ...ZERO }));
    return c;
  }

  today(day: string): ModelCounts[] {
    return [...(this.byDay.get(day) ?? new Map<string, TokenCounts>())]
      .map(([model, c]) => ({ model, ...c }))
      .filter((c) => total(c) > 0);
  }

  prune(day: string): void {
    for (const d of this.byDay.keys()) if (d < day) this.byDay.delete(d);
  }
}

interface SeenMessage {
  session: SessionUsage;
  day: string;
  model: string;
  counts: TokenCounts;
}

/** Claude records, keyed globally by message id (see the module note). */
export class ClaudeUsageReducer {
  private readonly seen = new Map<string, SeenMessage>();

  /** Fold one transcript record into `session`. */
  reduce(session: SessionUsage, record: unknown): void {
    if (!record || typeof record !== 'object') return;
    const r = record as Record<string, any>;
    if (typeof r.cwd === 'string' && r.isSidechain !== true) session.cwd = r.cwd;
    if (r.type === 'system' && r.subtype === 'compact_boundary' && r.isSidechain !== true) {
      session.compactions++;
      return;
    }
    const message = r.message;
    const usage = message?.usage;
    if (r.type !== 'assistant' || !usage || typeof usage !== 'object') return;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) return;
    const counts: TokenCounts = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    // Synthetic messages (API errors, interrupts) report all zeros.
    if (total(counts) === 0) return;
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    if (model === '<synthetic>') return;
    const day = localDay(at);
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id) {
      const prior = this.seen.get(id);
      if (prior) {
        if (total(counts) <= total(prior.counts)) return;
        add(prior.session.bucket(prior.day, prior.model), prior.counts, -1);
      }
      this.seen.set(id, { session, day, model, counts });
    }
    add(session.bucket(day, model), counts);
  }

  /** Forget messages from before `day`: they can no longer change today. */
  prune(day: string): void {
    for (const [id, s] of this.seen) if (s.day < day) this.seen.delete(id);
  }
}

/** Codex: running totals become per-record deltas. */
export class CodexUsageReducer {
  private model = 'unknown';
  /** Last running total seen; undefined until the first one. */
  private last?: TokenCounts;
  id?: string;

  constructor(
    readonly session: SessionUsage,
    /** True when reading started mid-file: the first total is a baseline, not usage. */
    private readonly startedMidFile = false,
  ) {}

  reduce(record: unknown): void {
    if (!record || typeof record !== 'object') return;
    const r = record as Record<string, any>;
    const p = r.payload;
    if (r.type === 'compacted') {
      this.session.compactions++;
      return;
    }
    if (!p || typeof p !== 'object') return;
    if (r.type === 'session_meta') {
      if (typeof (p.id ?? p.session_id) === 'string') this.id = p.id ?? p.session_id;
      if (typeof p.cwd === 'string') this.session.cwd = p.cwd;
      return;
    }
    if (r.type === 'turn_context') {
      if (typeof p.model === 'string') this.model = p.model;
      if (typeof p.cwd === 'string') this.session.cwd = p.cwd;
      return;
    }
    if (r.type !== 'event_msg' || p.type !== 'token_count') return;
    const info = p.info;
    if (!info || typeof info !== 'object') return;
    if (num(info.model_context_window)) this.session.contextWindow = info.model_context_window;
    const t = info.total_token_usage;
    if (!t || typeof t !== 'object') return;
    const cached = num(t.cached_input_tokens);
    const now: TokenCounts = {
      // Codex's input includes the cached part; split it out like Claude's.
      input: Math.max(0, num(t.input_tokens) - cached),
      output: num(t.output_tokens),
      cacheRead: cached,
      cacheWrite: num(t.cache_write_input_tokens),
    };
    const prev = this.last;
    this.last = now;
    if (!prev && this.startedMidFile) return;
    const base = prev ?? ZERO;
    // A total that went down means the counter restarted: all of it is new.
    const restarted = total(now) < total(base);
    const delta: TokenCounts = restarted
      ? now
      : {
          input: Math.max(0, now.input - base.input),
          output: Math.max(0, now.output - base.output),
          cacheRead: Math.max(0, now.cacheRead - base.cacheRead),
          cacheWrite: Math.max(0, now.cacheWrite - base.cacheWrite),
        };
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at) || total(delta) === 0) return;
    add(this.session.bucket(localDay(at), this.model), delta);
  }
}

/** Cheap pre-filter: skip JSON.parse for lines that can't matter. */
const CLAUDE_KEYS = ['"usage"', 'compact_boundary'];
const CODEX_KEYS = ['"token_count"', '"turn_context"', '"session_meta"', '"compacted"'];

function mayMatter(line: string, keys: readonly string[]): boolean {
  for (const k of keys) if (line.includes(k)) return true;
  return false;
}

/** Incremental reader of one log: tail-first, chunked, restarts on rewrite. */
export class LogFollower {
  offset = -1;
  private pending = '';
  private ino = 0;
  private dropFragment = false;
  /**
   * Reading (re)starts: `midFile` when the first read skipped the file's
   * start. Called before any record of that read, and again when the file was
   * rewritten or replaced, so the owner can reset what it derived.
   */
  onStart?: (midFile: boolean) => void;

  constructor(
    readonly file: string,
    private readonly keys: readonly string[],
    private readonly onRecord: (record: unknown) => void,
  ) {}

  /** Read what's new, at most one chunk. Returns true while more remains. */
  async step(): Promise<boolean> {
    const handle = await fs.open(this.file, 'r');
    try {
      const stat = await handle.stat();
      if (this.offset >= 0 && ((this.ino && stat.ino !== this.ino) || stat.size < this.offset)) {
        this.offset = -1;
      }
      this.ino = stat.ino;
      if (this.offset < 0) {
        this.offset = Math.max(0, stat.size - USAGE_FIRST_READ_MAX_BYTES);
        this.pending = '';
        // A mid-file start lands inside a record; drop that fragment.
        this.dropFragment = this.offset > 0;
        this.onStart?.(this.offset > 0);
      }
      const length = Math.min(USAGE_READ_CHUNK_BYTES, stat.size - this.offset);
      if (length <= 0) return false;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      if (!bytesRead) return false;
      this.offset += bytesRead;
      const lines = (this.pending + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      this.pending = lines.pop() ?? '';
      // One record bigger than this is a pasted blob, never usage: let it go.
      if (this.pending.length > USAGE_READ_CHUNK_BYTES * 4) this.pending = '';
      if (this.dropFragment && lines.length) {
        lines.shift();
        this.dropFragment = false;
      }
      for (const line of lines) {
        if (!line || !mayMatter(line, this.keys)) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // a malformed line must not stop the rest
        }
        this.onRecord(record);
      }
      return this.offset < stat.size;
    } finally {
      await handle.close();
    }
  }
}

export interface UsageSources {
  claudeProjects: string;
  codexSessions?: string;
}

function defaultSources(): UsageSources {
  return {
    claudeProjects: path.join(os.homedir(), '.claude', 'projects'),
    codexSessions:
      process.env.PIXEL_AGENTS_CODEX === '0'
        ? undefined
        : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  };
}

/** Logs modified since `since`: Claude sessions and their subagent files, Codex rollouts. */
async function logsSince(dir: string, since: number, depth: number): Promise<string[]> {
  const out: string[] = [];
  let items: import('node:fs').Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing or unreadable: normal when a tool isn't installed
  }
  for (const item of items) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (depth > 0) out.push(...(await logsSince(file, since, depth - 1)));
    } else if (item.isFile() && item.name.endsWith('.jsonl')) {
      try {
        if ((await fs.stat(file)).mtimeMs >= since) out.push(file);
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return out;
}

/** Session id an agent carries for a Claude log: the session file, or its parent for a subagent. */
export function claudeSessionOf(file: string): string {
  const dir = path.dirname(file);
  if (path.basename(dir) === 'subagents') return path.basename(path.dirname(dir));
  return path.basename(file, '.jsonl');
}

interface Tracked {
  follower: LogFollower;
  session: SessionUsage;
  /** Agent session id: Claude's session (shared by its subagent files) or `codex:<id>`. */
  sessionKey: () => string | undefined;
}

function merge(into: Map<string, TokenCounts>, models: ModelCounts[]): void {
  for (const { model, ...c } of models) {
    const m = into.get(model) ?? { ...ZERO };
    add(m, c);
    into.set(model, m);
  }
}

function toList(m: Map<string, TokenCounts>): ModelCounts[] {
  return [...m].map(([model, c]) => ({ model, ...c })).sort((a, b) => total(b) - total(a));
}

export class UsageTotals {
  private readonly tracked = new Map<string, Tracked>();
  private readonly claude = new ClaudeUsageReducer();
  private readonly projectOfCwd = new Map<string, string | undefined>();

  constructor(private readonly sources: UsageSources = defaultSources()) {}

  /** Find today's logs and start following new ones. */
  async scan(now = Date.now()): Promise<void> {
    const since = startOfLocalDay(now);
    const claudeFiles = await logsSince(this.sources.claudeProjects, since, 3);
    for (const file of claudeFiles) {
      if (this.tracked.has(file)) continue;
      const session = new SessionUsage();
      const follower = new LogFollower(file, CLAUDE_KEYS, (r) => this.claude.reduce(session, r));
      const key = claudeSessionOf(file);
      // A rewritten transcript re-reads from the top: message ids keep that from double-counting.
      this.tracked.set(file, { follower, session, sessionKey: () => key });
    }
    if (this.sources.codexSessions) {
      for (const file of await logsSince(this.sources.codexSessions, since, 4)) {
        if (this.tracked.has(file)) continue;
        this.trackCodex(file);
      }
    }
  }

  private trackCodex(file: string): void {
    const session = new SessionUsage();
    let reducer = new CodexUsageReducer(session);
    const follower = new LogFollower(file, CODEX_KEYS, (r) => reducer.reduce(r));
    follower.onStart = (midFile) => {
      session.byDay.clear();
      session.compactions = 0;
      reducer = new CodexUsageReducer(session, midFile);
    };
    this.tracked.set(file, {
      follower,
      session,
      sessionKey: () => (reducer.id ? `codex:${reducer.id}` : undefined),
    });
  }

  /** Read one chunk from every followed log. Returns true while any has more. */
  async read(): Promise<boolean> {
    let more = false;
    for (const [file, t] of this.tracked) {
      try {
        if (await t.follower.step()) more = true;
      } catch {
        this.tracked.delete(file); // gone or unreadable; a later scan may find it again
      }
    }
    return more;
  }

  private projectName(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined;
    if (!this.projectOfCwd.has(cwd)) this.projectOfCwd.set(cwd, resolveProject(cwd)?.root);
    return this.projectOfCwd.get(cwd);
  }

  /** Today's totals for the agents in the office and for every project. */
  message(store: AgentStateStore, now = Date.now()): UsageToday {
    const day = localDay(now);
    this.claude.prune(day);
    const bySession = new Map<string, { models: Map<string, TokenCounts>; s: SessionUsage[] }>();
    const byRoot = new Map<string, Map<string, TokenCounts>>();
    for (const t of this.tracked.values()) {
      t.session.prune(day);
      const models = t.session.today(day);
      const key = t.sessionKey();
      if (key) {
        const e = bySession.get(key) ?? {
          models: new Map<string, TokenCounts>(),
          s: [] as SessionUsage[],
        };
        merge(e.models, models);
        e.s.push(t.session);
        bySession.set(key, e);
      }
      const root = this.projectName(t.session.cwd);
      if (root && models.length) {
        const m = byRoot.get(root) ?? new Map();
        merge(m, models);
        byRoot.set(root, m);
      }
    }
    const names = projectDisplayNames(byRoot.keys());
    const nameOf = (root: string | undefined) =>
      root && byRoot.has(root) ? (names.get(root) ?? path.basename(root)) : undefined;
    const agents: AgentUsageToday[] = [];
    for (const [id, agent] of store.entries()) {
      // Subtask characters share their session's file; the session's agent carries it.
      if (agent.isFork) continue;
      const e = bySession.get(agent.sessionId);
      if (!e) continue;
      const compactions = e.s.reduce((n, s) => n + s.compactions, 0);
      const contextWindow = e.s.find((s) => s.contextWindow)?.contextWindow;
      const models = toList(e.models);
      if (!models.length && !compactions) continue;
      const project = nameOf(this.projectName(e.s.find((s) => s.cwd)?.cwd));
      agents.push({
        id,
        models,
        compactions,
        ...(contextWindow ? { contextWindow } : {}),
        ...(project ? { project } : {}),
      });
    }
    const projects = [...byRoot]
      .map(([root, m]) => ({ name: nameOf(root)!, models: toList(m) }))
      .sort((a, b) => sumModels(b.models) - sumModels(a.models));
    return { type: 'usageToday', day, agents, projects };
  }
}

function sumModels(models: ModelCounts[]): number {
  return models.reduce((n, m) => n + total(m), 0);
}

let latest: UsageToday | undefined;

/** The last usageToday sent, for a newly connected privileged client. */
export function usageTodaySnapshot(): UsageToday | undefined {
  return latest;
}

/** Follow today's logs and broadcast usageToday when it changes. */
export function startUsageTotals(
  store: AgentStateStore,
  sources?: UsageSources,
): { dispose(): void } {
  if (process.env.PIXEL_AGENTS_USAGE === '0') return { dispose() {} };
  const totals = new UsageTotals(sources);
  let stopped = false;
  let busy = false;
  let nextScan = 0;
  let sent = '';
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      if (Date.now() >= nextScan) {
        await totals.scan();
        nextScan = Date.now() + USAGE_SCAN_MS;
      }
      // Catch up a few chunks per tick so a big first read doesn't hog the loop.
      for (let i = 0; i < 4 && (await totals.read()); i++) {
        if (stopped) return;
      }
      const message = totals.message(store);
      const json = JSON.stringify(message);
      if (json !== sent) {
        sent = json;
        latest = message;
        store.broadcast({ ...message });
      }
    } catch {
      /* usage is decoration: never let it take the server down */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), USAGE_TICK_MS);
  timer.unref();
  void tick();
  return {
    dispose() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
