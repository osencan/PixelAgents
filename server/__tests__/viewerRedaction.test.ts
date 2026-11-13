import { describe, expect, it } from 'vitest';

import { redactForViewer, toolStatusCategory } from '../src/viewerRedaction.js';

describe('redactForViewer', () => {
  it('replaces commands, file names and subtask text with categories', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['Running: rm -rf build && npm test', 'Bash', 'Running a command'],
      ['Editing secrets.env', 'Edit', 'Editing a file'],
      ['Writing notes.md', 'Write', 'Editing a file'],
      ['Reading customer-list.csv', 'Read', 'Reading a file'],
      ['Subtask: audit the payroll export', 'Task', 'Subtask: details hidden'],
      ['Using mcp__private__thing', 'mcp__private__thing', 'Working'],
    ];
    for (const [status, toolName, expected] of cases) {
      expect(
        redactForViewer({ type: 'agentToolStart', id: 1, toolId: 't', status, toolName }),
      ).toEqual({
        type: 'agentToolStart',
        id: 1,
        toolId: 't',
        status: expected,
        toolName,
      });
    }
  });

  it('redacts sub-agent tool lines, which carry no tool name', () => {
    const out = redactForViewer({ type: 'subagentToolStart', id: 2, status: 'Running: git push' });
    expect(out.status).toBe('Running a command');
  });

  it('keeps content-free statuses and leaves other messages untouched', () => {
    expect(toolStatusCategory('Searching code', 'Grep')).toBe('Searching code');
    expect(toolStatusCategory('Waiting for your answer', 'AskUserQuestion')).toBe(
      'Waiting for your answer',
    );
    const status = { type: 'agentStatus', id: 1, status: 'active' };
    expect(redactForViewer(status)).toBe(status);
  });
});

describe('permission requests for viewers', () => {
  it('a read-only viewer gets the category, never the full request', () => {
    const out = redactForViewer({
      type: 'agentPermissionPending',
      id: 1,
      requestId: 'r',
      toolName: 'Bash',
      status: 'Running: rm -rf build',
      detail: 'rm -rf build && curl secret',
      complete: true,
      expiresAt: 1,
    });
    expect(out.status).toBe('Running a command');
    expect(out).not.toHaveProperty('detail');
  });
});

describe('agentKey', () => {
  it('is stable per session, opaque, and namespaced by provider', async () => {
    const { agentKey } = await import('../src/agentMessages.js');
    const a = agentKey({ sessionId: 'session-123', providerId: undefined });
    expect(a).toBe(agentKey({ sessionId: 'session-123', providerId: undefined }));
    expect(a).toMatch(/^claude:[0-9a-f]{16}$/);
    expect(a).not.toContain('session-123');
    expect(agentKey({ sessionId: 'codex:abc', providerId: 'codex' })).toMatch(/^codex:/);
    expect(agentKey({ sessionId: 'session-124', providerId: undefined })).not.toBe(a);
  });
});

describe('DismissalTracker ended sessions', () => {
  it('blocks re-adoption until the transcript is written again after the grace window', async () => {
    const { DismissalTracker } = await import('../src/dismissalTracker.js');
    const { ENDED_SESSION_WRITE_GRACE_MS } = await import('../src/constants.js');
    const tracker = new DismissalTracker();
    const endedAt = 1_000_000;
    tracker.markEnded('/t/s.jsonl', endedAt);
    // Final records written just after exit are not a resume.
    expect(tracker.isEndedUnchanged('/t/s.jsonl', endedAt + 5_000)).toBe(true);
    // A write well after the end is.
    expect(tracker.isEndedUnchanged('/t/s.jsonl', endedAt + ENDED_SESSION_WRITE_GRACE_MS + 1)).toBe(
      false,
    );
    expect(tracker.isEndedUnchanged('/t/s.jsonl', endedAt)).toBe(false);
    expect(tracker.isEndedUnchanged('/t/other.jsonl', endedAt)).toBe(false);
  });
});
