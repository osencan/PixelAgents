import * as crypto from 'crypto';
import * as fs from 'fs';

import {
  HOOK_API_PREFIX,
  PERMISSION_DECISION_PATH,
  PERMISSION_DECISION_WAIT_MS,
} from '../../../../constants.js';
import type { PermissionBehavior } from './serverRegistry.js';
import {
  liveServers,
  postToServer,
  readRegistry,
  requestPermissionDecision,
} from './serverRegistry.js';

/** Per-server POST timeout. */
const HOOK_POST_TIMEOUT_MS = 2000;
/** Extra wait beyond the server's hold, so the server's own answer arrives first. */
const PERMISSION_REQUEST_SLACK_MS = 3000;
/** How long an allow waits for a conflicting deny from another server. */
const CONFLICT_GRACE_MS = 300;

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry,
  // or the single legacy server.json when the registry has no live entries.
  const label = `event=${eventName} sid=${sid}`;
  const servers = liveServers(hookDebug, label);
  if (servers === null) process.exit(0);

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  const body = JSON.stringify(data);

  // A permission request may be answered from the office (opted-in projects):
  // ask every server, take the first decision, and print it as Claude's
  // documented hook output. No decision prints nothing, so the terminal
  // prompt -- shown in parallel all along -- decides.
  // Only servers from the registry may decide (not the legacy server.json).
  const deciders = readRegistry(hookDebug).filter((s) => s.decisionKey);
  if (eventName === 'PermissionRequest' && deciders.length > 0) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const asks = deciders.map((server) =>
      requestPermissionDecision(
        server,
        {
          path: `${HOOK_API_PREFIX}/claude/${PERMISSION_DECISION_PATH}`,
          body,
          label,
          debug: hookDebug,
          timeoutMs: PERMISSION_DECISION_WAIT_MS + PERMISSION_REQUEST_SLACK_MS,
        },
        nonce,
      ),
    );
    const decision = await firstDecision(asks.map((a) => a.decision));
    for (const a of asks) a.abort();
    if (decision) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: decision },
          },
        }),
      );
    }
    hookDebug(`exit reason=permission decision=${decision ?? 'none'}`);
    return;
  }

  await Promise.all(
    servers.map((server) =>
      postToServer(server, {
        path: `${HOOK_API_PREFIX}/claude`,
        body,
        label,
        debug: hookDebug,
        timeoutMs: HOOK_POST_TIMEOUT_MS,
      }),
    ),
  );
}

/** The first decision, deny winning: a deny is taken at once; an allow is
 *  taken once every server has answered or after a short grace for a
 *  conflicting deny. Null once every server has answered none. */
function firstDecision(
  decisions: Array<Promise<PermissionBehavior | null>>,
): Promise<PermissionBehavior | null> {
  return new Promise((resolve) => {
    let pending = decisions.length;
    let allowed = false;
    if (pending === 0) resolve(null);
    for (const d of decisions) {
      void d.then((value) => {
        pending -= 1;
        if (value === 'deny') return resolve('deny');
        if (value === 'allow' && !allowed) {
          allowed = true;
          setTimeout(() => resolve('allow'), pending > 0 ? CONFLICT_GRACE_MS : 0);
        }
        if (pending === 0) resolve(allowed ? 'allow' : null);
      });
    }
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
