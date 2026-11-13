import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => home };
});

const policy = await import('../src/controlPolicy.js');

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-control-')));
  policy.resetControlPolicyForTests();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('controlPolicy', () => {
  it('treats loopback and this machine as local, other addresses as remote', () => {
    expect(policy.isLocalAddress('127.0.0.1')).toBe(true);
    expect(policy.isLocalAddress('::1')).toBe(true);
    expect(policy.isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(policy.isLocalAddress('203.0.113.9')).toBe(false);
    expect(policy.isLocalAddress(undefined)).toBe(false);
  });

  it('stores the PIN as a salted hash only, and verifies it', () => {
    expect(policy.isValidPinShape('12345')).toBe(false);
    expect(policy.isValidPinShape('123456')).toBe(true);
    expect(policy.verifyControlPin('123456', '10.0.0.2')).toEqual({ ok: false, reason: 'no-pin' });
    policy.setControlPin('482913');
    const stored = fs.readFileSync(path.join(home, '.pixel-agents', 'control.json'), 'utf8');
    expect(stored).not.toContain('482913');
    expect(policy.verifyControlPin('482913', '10.0.0.2')).toEqual({ ok: true });
    expect(policy.verifyControlPin('000000', '10.0.0.2')).toEqual({ ok: false, reason: 'wrong' });
  });

  it('locks an address out after five wrong PINs, then lets it try again later', () => {
    policy.setControlPin('482913');
    const now = 1_000_000;
    for (let i = 0; i < policy.CONTROL_PIN_MAX_FAILURES - 1; i++) {
      expect(policy.verifyControlPin('000000', '10.0.0.3', now).ok).toBe(false);
    }
    const locked = policy.verifyControlPin('000000', '10.0.0.3', now);
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    // Even the right PIN is refused while locked; other addresses are unaffected.
    expect(policy.verifyControlPin('482913', '10.0.0.3', now + 1000)).toMatchObject({
      reason: 'locked',
    });
    expect(policy.verifyControlPin('482913', '10.0.0.4', now + 1000)).toEqual({ ok: true });
    expect(
      policy.verifyControlPin('482913', '10.0.0.3', now + policy.CONTROL_PIN_LOCKOUT_MS + 1),
    ).toEqual({
      ok: true,
    });
  });

  it('tickets slide while used, expire when idle, and a new PIN revokes them', () => {
    const t = policy.issueTicket(0);
    expect(policy.touchTicket(t, policy.CONTROL_IDLE_LOCK_MS - 1)).toBe(true);
    expect(policy.touchTicket(t, 2 * policy.CONTROL_IDLE_LOCK_MS - 2)).toBe(true);
    expect(policy.touchTicket(t, 4 * policy.CONTROL_IDLE_LOCK_MS)).toBe(false);
    const u = policy.issueTicket();
    policy.setControlPin('482913');
    expect(policy.touchTicket(u)).toBe(false);
  });

  it('keeps per-project approval opt-ins and audits without content', () => {
    expect(policy.isApprovalEnabled('/work/site')).toBe(false);
    policy.setApprovalEnabled('/work/site', true);
    expect(policy.isApprovalEnabled('/work/site')).toBe(true);
    policy.setApprovalEnabled('/work/site', false);
    expect(policy.approvalProjects()).toEqual([]);
    policy.auditControl({ action: 'unlock', client: 'remote', outcome: 'wrong' });
    const line = JSON.parse(
      fs.readFileSync(path.join(home, '.pixel-agents', 'control-audit.jsonl'), 'utf8').trim(),
    );
    expect(Object.keys(line).sort()).toEqual(['action', 'at', 'client', 'outcome']);
  });

  it('does not treat a relayed request as local, even from this machine (review fix)', () => {
    const host = { host: '127.0.0.1:3100' };
    expect(policy.isLocalRequest('127.0.0.1', host)).toBe(true);
    expect(policy.isLocalRequest('127.0.0.1', { host: 'localhost:3100' })).toBe(true);
    // A reverse proxy here relays a remote user: forwarding headers or a foreign Host.
    expect(policy.isLocalRequest('127.0.0.1', { ...host, 'x-forwarded-for': '203.0.113.9' })).toBe(
      false,
    );
    expect(policy.isLocalRequest('127.0.0.1', { ...host, forwarded: 'for=203.0.113.9' })).toBe(
      false,
    );
    expect(policy.isLocalRequest('127.0.0.1', { host: 'mac.tailnet.ts.net' })).toBe(false);
    expect(policy.isLocalRequest('127.0.0.1', {})).toBe(false);
    expect(policy.isLocalRequest('203.0.113.9', host)).toBe(false);
  });

  it('pauses every PIN unlock after many wrong PINs spread over addresses (review fix)', () => {
    policy.setControlPin('482913');
    const now = 5_000_000;
    for (let i = 0; i < policy.CONTROL_PIN_GLOBAL_MAX_FAILURES; i++) {
      policy.verifyControlPin('000000', `10.1.${i}.1`, now);
    }
    expect(policy.verifyControlPin('482913', '10.9.9.9', now + 1000)).toMatchObject({
      reason: 'locked',
    });
    expect(
      policy.verifyControlPin('482913', '10.9.9.9', now + policy.CONTROL_PIN_LOCKOUT_MS + 1),
    ).toEqual({
      ok: true,
    });
  });

  it('counts IPv6 failures per /64, so rotating addresses in one network does not reset them', () => {
    policy.setControlPin('482913');
    const now = 9_000_000;
    for (let i = 1; i <= policy.CONTROL_PIN_MAX_FAILURES; i++) {
      policy.verifyControlPin('000000', `2001:db8:1:2::${i}`, now);
    }
    expect(policy.verifyControlPin('482913', '2001:db8:1:2::99', now + 1)).toMatchObject({
      reason: 'locked',
    });
  });

  it('groups compressed IPv6 addresses by their real /64 (review fix)', () => {
    policy.setControlPin('482913');
    const now = 12_000_000;
    // Five failures from 2001:db8:0:0::/64, written two ways.
    for (let i = 1; i <= policy.CONTROL_PIN_MAX_FAILURES; i++) {
      policy.verifyControlPin('000000', i % 2 ? `2001:db8::${i}` : `2001:db8:0:0::${i}`, now);
    }
    expect(policy.verifyControlPin('482913', '2001:db8::abcd', now + 1)).toMatchObject({
      reason: 'locked',
    });
    // 2001:db8::3:0:0:0:1 is in 2001:db8:0:3::/64 -- a different network, not locked.
    expect(policy.verifyControlPin('482913', '2001:db8::3:0:0:0:1', now + 1)).toEqual({ ok: true });
  });

  it('the global pause spares devices that already unlocked (review fix)', () => {
    policy.setControlPin('482913');
    const now = 20_000_000;
    expect(policy.verifyControlPin('482913', '192.168.1.50', now)).toEqual({ ok: true }); // your phone
    for (let i = 0; i < policy.CONTROL_PIN_GLOBAL_MAX_FAILURES; i++) {
      policy.verifyControlPin('000000', `10.2.${i}.1`, now);
    }
    expect(policy.verifyControlPin('482913', '10.9.9.9', now + 1)).toMatchObject({
      reason: 'locked',
    });
    expect(policy.verifyControlPin('482913', '192.168.1.50', now + 1)).toEqual({ ok: true });
  });
});
