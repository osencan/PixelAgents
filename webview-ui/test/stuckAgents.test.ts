import { beforeEach, describe, expect, test } from 'vitest';

import {
  forgetAgent,
  noteAgentLifecycle,
  noteAgentNews,
  quietState,
  quietText,
  setLongTurnsOnly,
  setStuckMinutes,
  shouldNotifyQuiet,
  turnWorthAnnouncing,
} from '../src/office/stuckAgents.js';

const MIN = 60_000;
const T0 = 1_000_000_000;
const working = { lifecycle: 'running' as const, observed: true, since: T0 };

beforeEach(() => {
  setStuckMinutes(10);
  setLongTurnsOnly(false);
  forgetAgent(1);
});

describe('quiet agents', () => {
  test('a working agent with no news past the threshold reads Stuck?', () => {
    noteAgentNews(1, T0);
    expect(quietState(1, working, T0 + 9 * MIN)).toBeNull();
    const q = quietState(1, working, T0 + 11 * MIN);
    expect(q).toEqual({ kind: 'stuck', since: T0 });
    expect(quietText(q!, T0 + 11 * MIN)).toBe('Stuck? No news for 11m');
  });

  test('news resets the spell', () => {
    noteAgentNews(1, T0);
    noteAgentNews(1, T0 + 8 * MIN);
    expect(quietState(1, working, T0 + 11 * MIN)).toBeNull();
  });

  test('first sight counts as news: opening the page never makes everyone stuck', () => {
    expect(quietState(1, working, T0 + 60 * MIN)).toBeNull();
  });

  test('idle and waiting-for-input agents are never stuck', () => {
    noteAgentNews(1, T0);
    for (const lifecycle of ['idle', 'waiting_input', 'unknown'] as const) {
      expect(quietState(1, { lifecycle, observed: true, since: T0 }, T0 + 99 * MIN)).toBeNull();
    }
  });

  test('a reported approval request still waiting reads Still needs you', () => {
    const waiting = { lifecycle: 'waiting_permission' as const, observed: true, since: T0 };
    expect(quietState(1, waiting, T0 + 5 * MIN)).toBeNull();
    const q = quietState(1, waiting, T0 + 12 * MIN);
    expect(q?.kind).toBe('needs_you');
    expect(quietText(q!, T0 + 12 * MIN)).toBe('Still needs you (12m)');
  });

  test('each spell notifies once', () => {
    noteAgentNews(1, T0);
    const q = quietState(1, working, T0 + 11 * MIN)!;
    expect(shouldNotifyQuiet(1, q)).toBe(true);
    expect(shouldNotifyQuiet(1, quietState(1, working, T0 + 20 * MIN)!)).toBe(false);
    noteAgentNews(1, T0 + 21 * MIN);
    expect(shouldNotifyQuiet(1, quietState(1, working, T0 + 32 * MIN)!)).toBe(true);
  });

  test('Off turns it off', () => {
    setStuckMinutes(0);
    noteAgentNews(1, T0);
    expect(quietState(1, working, T0 + 999 * MIN)).toBeNull();
  });
});

describe('long turns only', () => {
  test('announces every turn by default', () => {
    noteAgentLifecycle(1, 'idle', 'thinking', T0);
    expect(turnWorthAnnouncing(1, T0 + 5_000)).toBe(true);
  });

  test('when on, a short turn stays quiet and a long one is announced', () => {
    setLongTurnsOnly(true);
    noteAgentLifecycle(1, 'idle', 'thinking', T0);
    noteAgentLifecycle(1, 'thinking', 'running', T0 + 1_000);
    expect(turnWorthAnnouncing(1, T0 + 30_000)).toBe(false);
    expect(turnWorthAnnouncing(1, T0 + 90_000)).toBe(true);
  });

  test('an unknown start (page opened mid-turn) is announced', () => {
    setLongTurnsOnly(true);
    expect(turnWorthAnnouncing(1, T0)).toBe(true);
  });
});
