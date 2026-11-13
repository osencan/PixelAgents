/**
 * Browser answers to Claude permission requests.
 *
 * Claude's PermissionRequest hook may print a decision (allow/deny). Our hook
 * script asks the server; the broker holds that request until a control
 * client answers in the office, the session moves on (the user answered in
 * the terminal, which shows its prompt in parallel the whole time), the hook
 * goes away, or PERMISSION_DECISION_WAIT_MS passes. "No decision" leaves the
 * terminal prompt in charge.
 *
 * Requests are only held for projects opted in to browser approvals, and only
 * while a control-capable client is connected; otherwise the answer is "no
 * decision" at once.
 */
import * as crypto from 'node:crypto';

import { agentKey } from './agentMessages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PERMISSION_DECISION_WAIT_MS } from './constants.js';
import { auditControl, hasControlClient, isApprovalEnabled } from './controlPolicy.js';
import { resolveProject } from './projectIdentity.js';
import { formatToolStatus } from './providers/hook/claude/claude.js';

export type PermissionBehavior = 'allow' | 'deny';
type Outcome = PermissionBehavior | 'timeout' | 'withdrawn' | 'elsewhere';

/** Hook events that mean the session moved past its permission prompt. */
const SESSION_MOVED_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
]);

/** Longest full request shown for review; longer ones can't be approved here. */
export const PERMISSION_DETAIL_MAX_CHARS = 8192;

/** Characters that render as nothing, reorder text or vary by font: control
 *  and format characters (bidi, zero-width), private-use and unassigned code
 *  points, line/paragraph separators, blank fillers and variation selectors.
 *  Tab and newline are allowed. */
const HIDDEN_SOURCE =
  '(?![\\t\\n])[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\u034F\\u115F\\u1160\\u3164\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]';
const HIDDEN_CHARS = new RegExp(HIDDEN_SOURCE, 'u');
const HIDDEN_CHARS_ALL = new RegExp(HIDDEN_SOURCE, 'gu');

function escapeChar(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
}

/**
 * Everything the approval is about, untruncated: the whole command, the
 * absolute path, the URL, or the tool's full input. The short status line is
 * lossy (truncated commands, file names only), so approving needs this.
 */
export function permissionDetail(
  toolName: string,
  input: unknown,
): { detail: string; complete: boolean } {
  const inp = (input ?? {}) as Record<string, unknown>;
  let detail: string;
  const keys = Object.keys(inp);
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k));
  // The bare value only when nothing else in the request could change what runs.
  if (toolName === 'Bash' && typeof inp.command === 'string' && only(['command', 'description']))
    detail = inp.command;
  else if (typeof inp.file_path === 'string' && only(['file_path'])) detail = inp.file_path;
  else if (toolName === 'WebFetch' && typeof inp.url === 'string' && only(['url']))
    detail = inp.url;
  else detail = JSON.stringify(inp, null, 2);
  // Invisible or reordering characters could make what is shown differ from
  // what runs: show them as escapes, and allow Deny only.
  const hidden = HIDDEN_CHARS.test(detail);
  if (hidden) detail = detail.replace(HIDDEN_CHARS_ALL, escapeChar);
  const complete = !hidden && detail.length <= PERMISSION_DETAIL_MAX_CHARS;
  return {
    detail:
      detail.length <= PERMISSION_DETAIL_MAX_CHARS
        ? detail
        : detail.slice(0, PERMISSION_DETAIL_MAX_CHARS),
    complete,
  };
}

interface Pending {
  requestId: string;
  agentId: number;
  sessionId: string;
  toolName: string;
  target: string;
  detail: string;
  complete: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionBehavior | null) => void;
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private store: AgentStateStore,
    private waitMs = PERMISSION_DECISION_WAIT_MS,
  ) {}

  /** A PermissionRequest hook asks for a decision. `onAbort` registers the
   *  hook going away (its HTTP request closed). */
  ask(
    event: Record<string, unknown>,
    onAbort: (cb: () => void) => void,
  ): Promise<PermissionBehavior | null> {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    const found = [...this.store].find(([, a]) => a.sessionId === sessionId);
    if (!found) return Promise.resolve(null);
    const [agentId, agent] = found;
    // The project as of this request (the hook reports its cwd; a brand-new
    // session may not have been labelled yet), else the agent's or its lead's.
    const cwd = typeof event.cwd === 'string' ? event.cwd : '';
    const root =
      (cwd ? resolveProject(cwd)?.root : undefined) ??
      agent.projectRoot ??
      this.store.get(agent.leadAgentId ?? -1)?.projectRoot;
    if (!isApprovalEnabled(root) || !hasControlClient()) return Promise.resolve(null);

    const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
    const target = formatToolStatus(toolName, event.tool_input);
    const { detail, complete } = permissionDetail(toolName, event.tool_input);
    const requestId = crypto.randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + this.waitMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(requestId, 'timeout'), this.waitMs);
      this.pending.set(requestId, {
        requestId,
        agentId,
        sessionId,
        toolName,
        target,
        detail,
        complete,
        expiresAt,
        timer,
        resolve,
      });
      onAbort(() => this.finish(requestId, 'withdrawn'));
      this.store.broadcast(pendingMessage(this.pending.get(requestId)!));
    });
  }

  /** A control client answered. False when the request is no longer pending. */
  decide(requestId: string, behavior: PermissionBehavior, client: 'local' | 'remote'): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    const agent = this.store.get(p.agentId);
    // Approving needs the whole request on screen; too long to show = terminal only.
    const refused = behavior === 'allow' && !p.complete;
    auditControl({
      action: `permission-${behavior}`,
      client,
      outcome: refused ? 'refused-incomplete' : 'ok',
      agentKey: agent ? agentKey(agent) : undefined,
      project: agent?.directoryName,
    });
    if (refused) return false;
    this.finish(requestId, behavior);
    return true;
  }

  /** Any hook event: a session that moved on answered its prompt elsewhere. */
  observe(event: Record<string, unknown>): void {
    if (!SESSION_MOVED_EVENTS.has(String(event.hook_event_name))) return;
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === event.session_id) this.finish(p.requestId, 'elsewhere');
    }
  }

  /** Pending requests, for a (re)connecting client. */
  snapshot(send: (message: Record<string, unknown>) => void): void {
    for (const p of this.pending.values()) send(pendingMessage(p));
  }

  dispose(): void {
    for (const p of [...this.pending.values()]) this.finish(p.requestId, 'withdrawn');
  }

  private finish(requestId: string, outcome: Outcome): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    this.store.broadcast({ type: 'agentPermissionResolved', id: p.agentId, requestId, outcome });
    p.resolve(outcome === 'allow' || outcome === 'deny' ? outcome : null);
  }
}

function pendingMessage(p: Pending): Record<string, unknown> {
  return {
    type: 'agentPermissionPending',
    id: p.agentId,
    requestId: p.requestId,
    toolName: p.toolName,
    status: p.target,
    // Full request: stripped for connections without control (httpServer).
    detail: p.detail,
    complete: p.complete,
    expiresAt: p.expiresAt,
  };
}

// The broker per store, so transport code reaches it without extra plumbing.
const brokers = new WeakMap<AgentStateStore, PermissionBroker>();

export function startPermissionBroker(store: AgentStateStore): PermissionBroker {
  const broker = new PermissionBroker(store);
  brokers.set(store, broker);
  return broker;
}

export function permissionBrokerFor(store: AgentStateStore): PermissionBroker | undefined {
  return brokers.get(store);
}
