/**
 * Who may CONTROL agents (answer permission requests, launch, type), as
 * opposed to watching or editing the office.
 *
 * - A tokened connection from this machine (loopback or one of its own
 *   interface addresses) controls with the token alone.
 * - Any other tokened connection must first unlock with the control PIN. The
 *   PIN is set from this machine only and stored as a salted scrypt hash in
 *   ~/.pixel-agents/control.json. Wrong PINs lock the address out for a while.
 * - Every control action is appended to ~/.pixel-agents/control-audit.jsonl
 *   (what, when, from where; never PINs, commands, prompts or keystrokes).
 *
 * Accepted risk: over plain HTTP the token and PIN cross the network
 * unencrypted; HTTPS (a reverse proxy on this machine) avoids sending them.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentStateStore } from './agentStateStore.js';
import { PIXEL_AGENTS_DIR } from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';

/** Accepted PIN shape: 6-12 digits. */
const PIN_PATTERN = /^\d{6,12}$/;
/** Wrong PINs from one address before it is locked out. */
export const CONTROL_PIN_MAX_FAILURES = 5;
/** How long a locked-out address must wait. */
export const CONTROL_PIN_LOCKOUT_MS = 15 * 60_000;
/** A PIN unlock lapses after this long without control actions. */
export const CONTROL_IDLE_LOCK_MS = 30 * 60_000;
const SCRYPT_KEY_LENGTH = 32;

interface StoredPin {
  salt: string;
  hash: string;
}

interface ControlFile {
  pin?: StoredPin;
  /** Project roots whose permission requests may be answered from a browser. */
  approvalProjects: string[];
}

function controlDir(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR);
}

let cache: ControlFile | undefined;

function read(): ControlFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(controlDir(), 'control.json'), 'utf8'),
    ) as Partial<ControlFile>;
    cache = {
      pin:
        raw.pin && typeof raw.pin.salt === 'string' && typeof raw.pin.hash === 'string'
          ? raw.pin
          : undefined,
      approvalProjects: Array.isArray(raw.approvalProjects)
        ? raw.approvalProjects.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch {
    cache = { approvalProjects: [] };
  }
  return cache;
}

function write(next: ControlFile): void {
  cache = next;
  writeJsonAtomic(path.join(controlDir(), 'control.json'), next);
}

// ── Where a connection comes from ─────────────────────────────

function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/, '').toLowerCase();
}

/** True when the peer address is this machine (loopback or an own interface). */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = normalizeAddress(address);
  if (a === '::1' || a.startsWith('127.')) return true;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (normalizeAddress(ni.address) === a) return true;
    }
  }
  return false;
}

/** Headers a relay may set to name the real client or hop. Any of them means
 *  "not someone at this machine", so the PIN is needed. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-cluster-client-ip',
  'via',
  'tailscale-user-login',
];

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(host) ?? /^([^:]+)(?::\d+)?$/.exec(host);
  return m ? m[1].toLowerCase() : host.toLowerCase();
}

/**
 * Whether a request truly comes from someone at this machine, so it may
 * control with the token alone: the peer is this machine, AND nothing says it
 * was relayed (a reverse proxy on this machine connects from a local address on
 * behalf of a remote user), AND it addresses this machine by a loopback name or
 * one of its own addresses. A proxied user therefore needs the PIN.
 */
export function isLocalRequest(
  peerAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!isLocalAddress(peerAddress)) return false;
  if (FORWARDING_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const host = hostnameOf(typeof headers.host === 'string' ? headers.host : undefined);
  if (!host) return false;
  return host === 'localhost' || isLocalAddress(host);
}

// ── PIN ───────────────────────────────────────────────────────

export function isPinSet(): boolean {
  return read().pin !== undefined;
}

export function isValidPinShape(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

/** Set (replace) the control PIN. Revokes every outstanding unlock. */
export function setControlPin(pin: string): void {
  if (!isValidPinShape(pin)) throw new Error('invalid PIN');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, SCRYPT_KEY_LENGTH);
  write({ ...read(), pin: { salt: salt.toString('hex'), hash: hash.toString('hex') } });
  revokeAllTickets();
  // A new PIN: devices must prove it again before skipping the global pause.
  knownGood.clear();
}

const failures = new Map<string, { count: number; lockedUntil: number }>();
/** Wrong PINs from all addresses within the window, before every PIN unlock pauses. */
export const CONTROL_PIN_GLOBAL_MAX_FAILURES = 20;
let globalFailures: number[] = [];
let globalLockedUntil = 0;

/** The eight 16-bit groups of an IPv6 address, '::' expanded (no zone id). */
function expandIPv6(address: string): string[] {
  const [head, tail] = address.split('%')[0].split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill =
    tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].map((g) => (parseInt(g || '0', 16) || 0).toString(16));
}

/** IPv6 addresses count per /64 (one device can hold many); IPv4 per address. */
function failureKey(address: string): string {
  const a = normalizeAddress(address);
  if (!a.includes(':')) return a;
  return expandIPv6(a).slice(0, 4).join(':') + '::/64';
}

/** Addresses (failure keys) that have unlocked with the right PIN since start:
 *  the global pause does not apply to them, so an attacker spraying wrong
 *  PINs cannot lock the operator's own devices out (their per-address
 *  lockout still applies). */
const knownGood = new Set<string>();

export type PinVerdict =
  { ok: true } | { ok: false; reason: 'no-pin' | 'wrong' | 'locked'; lockedUntil?: number };

/** Check a PIN for an address, counting failures and locking out. */
export function verifyControlPin(pin: unknown, address: string, now = Date.now()): PinVerdict {
  const key = failureKey(address);
  const state = failures.get(key);
  if (state && state.lockedUntil > now)
    return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil };
  // Spread over many addresses, guesses still pause PIN unlocks from new ones.
  if (globalLockedUntil > now && !knownGood.has(key)) {
    return { ok: false, reason: 'locked', lockedUntil: globalLockedUntil };
  }
  const stored = read().pin;
  if (!stored) return { ok: false, reason: 'no-pin' };
  const expected = Buffer.from(stored.hash, 'hex');
  const actual =
    typeof pin === 'string'
      ? crypto.scryptSync(pin, Buffer.from(stored.salt, 'hex'), SCRYPT_KEY_LENGTH)
      : Buffer.alloc(expected.length);
  if (typeof pin === 'string' && crypto.timingSafeEqual(actual, expected)) {
    failures.delete(key);
    knownGood.add(key);
    return { ok: true };
  }
  globalFailures = [...globalFailures.filter((t) => now - t < CONTROL_PIN_LOCKOUT_MS), now];
  if (globalFailures.length >= CONTROL_PIN_GLOBAL_MAX_FAILURES) {
    globalLockedUntil = now + CONTROL_PIN_LOCKOUT_MS;
    globalFailures = [];
  }
  // A lockout that has run out starts the count afresh.
  const previous = state && state.lockedUntil === 0 ? state.count : 0;
  const count = previous + 1;
  if (count >= CONTROL_PIN_MAX_FAILURES) {
    const lockedUntil = now + CONTROL_PIN_LOCKOUT_MS;
    failures.set(key, { count: 0, lockedUntil });
    return { ok: false, reason: 'locked', lockedUntil };
  }
  failures.set(key, { count, lockedUntil: 0 });
  return { ok: false, reason: 'wrong' };
}

// ── Tickets (a PIN unlock, presentable by the terminal socket) ──

const tickets = new Map<string, { lastUsed: number }>();

export function issueTicket(now = Date.now()): string {
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { lastUsed: now });
  return ticket;
}

/** True while the ticket exists and was used within the idle limit (sliding). */
export function touchTicket(ticket: string | undefined, now = Date.now()): boolean {
  if (!ticket) return false;
  const t = tickets.get(ticket);
  if (!t) return false;
  if (now - t.lastUsed > CONTROL_IDLE_LOCK_MS) {
    tickets.delete(ticket);
    return false;
  }
  t.lastUsed = now;
  return true;
}

/** Callbacks per ticket, run when it is revoked (Lock, new PIN). */
const revokeWatchers = new Map<string, Set<() => void>>();

/** Be told when a ticket is revoked (a terminal socket closes itself). */
export function watchTicket(ticket: string, onRevoke: () => void): () => void {
  const set = revokeWatchers.get(ticket) ?? new Set<() => void>();
  set.add(onRevoke);
  revokeWatchers.set(ticket, set);
  return () => set.delete(onRevoke);
}

/** Whether a ticket is still valid, WITHOUT counting as use (output only). */
export function isTicketValid(ticket: string | undefined, now = Date.now()): boolean {
  const t = ticket ? tickets.get(ticket) : undefined;
  return !!t && now - t.lastUsed <= CONTROL_IDLE_LOCK_MS;
}

function notifyRevoked(ticket: string): void {
  const set = revokeWatchers.get(ticket);
  revokeWatchers.delete(ticket);
  for (const cb of set ?? []) cb();
}

export function revokeTicket(ticket: string | undefined): void {
  if (!ticket) return;
  tickets.delete(ticket);
  notifyRevoked(ticket);
}

export function revokeAllTickets(): void {
  const all = [...tickets.keys(), ...revokeWatchers.keys()];
  tickets.clear();
  for (const t of new Set(all)) notifyRevoked(t);
}

// ── Connected control clients ─────────────────────────────────

const controlSockets = new Set<object>();

/** The transport reports each socket's control state (and its close). */
export function setControlSocket(socket: object, control: boolean): void {
  if (control) controlSockets.add(socket);
  else controlSockets.delete(socket);
}

/** Whether anyone connected right now could answer a permission request. */
export function hasControlClient(): boolean {
  return controlSockets.size > 0;
}

// ── Per-project approval opt-in ───────────────────────────────

export function isApprovalEnabled(root: string | undefined): boolean {
  return !!root && read().approvalProjects.includes(root);
}

export function setApprovalEnabled(root: string, enabled: boolean): void {
  const current = read().approvalProjects.filter((p) => p !== root);
  write({ ...read(), approvalProjects: enabled ? [...current, root] : current });
}

export function approvalProjects(): readonly string[] {
  return read().approvalProjects;
}

/** The agents whose project is opted in (for the tokened panels' switch). */
export function approvalOptInsMessage(store: AgentStateStore): Record<string, unknown> {
  const agentIds: number[] = [];
  for (const [id, agent] of store) if (isApprovalEnabled(agent.projectRoot)) agentIds.push(id);
  return { type: 'approvalOptIns', agentIds };
}

/** Re-announce opt-ins when agents arrive or change project. */
export function startApprovalOptInBroadcaster(store: AgentStateStore): { dispose(): void } {
  let last = '';
  let scheduled = false;
  const announce = () => {
    scheduled = false;
    const msg = approvalOptInsMessage(store);
    const key = JSON.stringify(msg.agentIds);
    if (key === last) return;
    last = key;
    store.broadcast(msg);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(announce);
  };
  const onBroadcast = (m: Record<string, unknown>) => {
    if (m.type === 'agentDirectoryChanged' || m.type === 'approvalOptIns') {
      if (m.type === 'approvalOptIns') last = JSON.stringify(m.agentIds);
      else schedule();
    }
  };
  store.on('agentAdded', schedule);
  store.on('agentRemoved', schedule);
  store.on('broadcast', onBroadcast);
  return {
    dispose() {
      store.off('agentAdded', schedule);
      store.off('agentRemoved', schedule);
      store.off('broadcast', onBroadcast);
    },
  };
}

// ── Audit ─────────────────────────────────────────────────────

/** Append one control action. Fields must never carry PINs or content. */
export function auditControl(entry: {
  action: string;
  client: 'local' | 'remote';
  outcome: string;
  agentKey?: string;
  project?: string;
}): void {
  try {
    fs.mkdirSync(controlDir(), { recursive: true });
    fs.appendFileSync(
      path.join(controlDir(), 'control-audit.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* auditing must never break control handling */
  }
}

/** Tests only. */
export function resetControlPolicyForTests(): void {
  cache = undefined;
  failures.clear();
  controlSockets.clear();
  revokeWatchers.clear();
  globalFailures = [];
  globalLockedUntil = 0;
  knownGood.clear();
  tickets.clear();
}
