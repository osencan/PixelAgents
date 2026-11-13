import { describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('../src/transport/index.js', () => ({ transport: { send: (m: unknown) => sent.push(m) } }));

const store = await import('../src/office/permissionRequests.js');
const base = { agentId: 3, toolName: 'Bash', status: 'Running: npm test', expiresAt: 1 };

describe('pending permission requests', () => {
  it('answers exactly the request shown, once', () => {
    store.setPendingPermission({ ...base, requestId: 'r1', complete: true });
    store.answerPermission('r1', 'allow');
    store.answerPermission('r1', 'deny');
    expect(sent).toEqual([{ type: 'approvePermission', requestId: 'r1', behavior: 'allow' }]);
    store.clearPendingPermission('r1');
    expect(store.getPendingPermission(3)).toBeUndefined();
  });

  it('a newer request for the same agent is not answered by an older button (review fix)', () => {
    sent.length = 0;
    store.setPendingPermission({ ...base, requestId: 'old', complete: true });
    store.setPendingPermission({ ...base, requestId: 'new', complete: true });
    store.clearPendingPermission('old');
    store.answerPermission('old', 'allow'); // the stale button
    expect(sent).toEqual([]);
    expect(store.getPendingPermission(3)?.requestId).toBe('new');
    store.clearAgentPermissions(3);
  });

  it('a request too long to show in full can be denied but not approved (review fix)', () => {
    sent.length = 0;
    store.setPendingPermission({ ...base, requestId: 'long', complete: false });
    store.answerPermission('long', 'allow');
    expect(sent).toEqual([]);
    store.answerPermission('long', 'deny');
    expect(sent).toEqual([{ type: 'approvePermission', requestId: 'long', behavior: 'deny' }]);
  });
});
