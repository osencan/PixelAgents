import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_HISTORY_MAX, TOAST_DURATION_MS, TOAST_MAX_VISIBLE } from '../src/constants.js';
import {
  appendAgentHistory,
  clearAgentHistory,
  getAgentHistory,
  setAgentHistory,
} from '../src/office/agentHistory.js';
import {
  dismissAgentToasts,
  getToasts,
  lifecycleNotice,
  pauseToast,
  pushToast,
  resumeToast,
  setNotificationsEnabled,
} from '../src/office/notifications.js';

afterEach(() => {
  vi.useRealTimers();
  setNotificationsEnabled(true);
});

describe('lifecycleNotice', () => {
  const reported = (lifecycle: string) => ({ lifecycle, observed: true });

  it('notices a reported permission request and a finished turn', () => {
    expect(lifecycleNotice(reported('running'), reported('waiting_permission'))).toBe('approval');
    expect(lifecycleNotice(reported('running'), reported('idle'))).toBe('finished');
    expect(lifecycleNotice(reported('thinking'), reported('waiting_input'))).toBe('finished');
  });

  it('stays quiet for guesses, repeats, first sight and non-events', () => {
    expect(lifecycleNotice(reported('running'), { lifecycle: 'idle', observed: false })).toBeNull();
    expect(lifecycleNotice(reported('idle'), reported('idle'))).toBeNull();
    expect(lifecycleNotice(undefined, reported('idle'))).toBeNull();
    expect(lifecycleNotice(reported('unknown'), reported('idle'))).toBeNull();
    expect(lifecycleNotice(reported('idle'), reported('running'))).toBeNull();
  });
});

describe('toasts', () => {
  it('keep the newest few, expire, and stop when switched off', () => {
    vi.useFakeTimers();
    for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i++)
      pushToast({ agentId: i, kind: 'finished', text: `t${i}` });
    expect(getToasts()).toHaveLength(TOAST_MAX_VISIBLE);
    expect(getToasts().at(-1)?.text).toBe(`t${TOAST_MAX_VISIBLE + 1}`);
    vi.advanceTimersByTime(TOAST_DURATION_MS + 1);
    expect(getToasts()).toHaveLength(0);
    setNotificationsEnabled(false);
    pushToast({ agentId: 1, kind: 'approval', text: 'x' });
    expect(getToasts()).toHaveLength(0);
  });
});

describe('toast accessibility fixes (B.4)', () => {
  it('keeps approval requests until answered, and pauses others while hovered or focused', () => {
    vi.useFakeTimers();
    pushToast({ agentId: 7, kind: 'approval', text: 'needs approval' });
    pushToast({ agentId: 8, kind: 'finished', text: 'done' });
    const done = getToasts().find((t) => t.kind === 'finished')!;
    pauseToast(done.key);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 3);
    expect(getToasts().map((t) => t.kind)).toEqual(['approval', 'finished']);
    resumeToast(done.key);
    vi.advanceTimersByTime(TOAST_DURATION_MS + 1);
    expect(getToasts().map((t) => t.kind)).toEqual(['approval']);
    // Approved: the request's notice goes away.
    dismissAgentToasts(7, 'approval');
    expect(getToasts()).toEqual([]);
  });
});

describe('agent history', () => {
  it('is seeded by the snapshot, extended live, bounded, and cleared with the agent', () => {
    setAgentHistory(4, [{ kind: 'state', lifecycle: 'idle', observed: true, at: 1 }]);
    for (let i = 0; i < AGENT_HISTORY_MAX + 3; i++)
      appendAgentHistory(4, { kind: 'tool_failed', at: i + 2 });
    expect(getAgentHistory(4)).toHaveLength(AGENT_HISTORY_MAX);
    expect(getAgentHistory(4).at(-1)).toEqual({ kind: 'tool_failed', at: AGENT_HISTORY_MAX + 4 });
    clearAgentHistory(4);
    expect(getAgentHistory(4)).toEqual([]);
  });
});
