/**
 * Test/build outcomes reported by the server (agentCheckResult): shown briefly
 * over the agent. Only real tool outcomes count; the command is never known
 * here, only whether it was a test or a build run.
 */
import { CHECK_RESULT_SHOW_MS } from '../constants.js';

export interface CheckResult {
  check: 'test' | 'build';
  ok: boolean;
  until: number;
}

const byId = new Map<number, CheckResult>();

export function showCheckResult(
  id: number,
  check: 'test' | 'build',
  ok: boolean,
  now = Date.now(),
): void {
  byId.set(id, { check, ok, until: now + CHECK_RESULT_SHOW_MS });
}

/** The result to show over this agent right now, if any. */
export function activeCheckResult(id: number, now = Date.now()): CheckResult | undefined {
  const r = byId.get(id);
  if (!r) return undefined;
  if (now < r.until) return r;
  byId.delete(id);
  return undefined;
}

export function clearCheckResult(id: number): void {
  byId.delete(id);
}

export function checkText(check: 'test' | 'build', ok: boolean): string {
  return check === 'test'
    ? ok
      ? 'Tests passed'
      : 'Tests failed'
    : ok
      ? 'Build passed'
      : 'Build failed';
}
