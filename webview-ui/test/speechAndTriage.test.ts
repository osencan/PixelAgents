import { beforeEach, describe, expect, test } from 'vitest';

import { SPEECH_REPLY_MS, TRIAGE_FREEZE_MS } from '../src/constants.js';
import {
  clearSpeech,
  clipSpeech,
  noteTurnFinished,
  speechFor,
} from '../src/office/speechBubbles.js';
import { forgetAgent, noteAgentNews, setStuckMinutes } from '../src/office/stuckAgents.js';
import { isEditableTarget, triageOrder, TriageStepper } from '../src/office/triage.js';

const T0 = 2_000_000_000;
const idle = { lifecycle: 'idle' as const, observed: true, since: T0 };
const running = { lifecycle: 'running' as const, observed: true, since: T0 };

beforeEach(() => {
  setStuckMinutes(10);
  forgetAgent(1);
  clearSpeech(1);
});

describe('speech bubbles', () => {
  test('a finished turn speaks its reply for a while, then falls silent', () => {
    noteTurnFinished(1, T0);
    expect(speechFor(1, idle, 'All tests pass now.', T0 + 1000)).toEqual({
      kind: 'reply',
      text: 'All tests pass now.',
    });
    expect(speechFor(1, idle, 'All tests pass now.', T0 + SPEECH_REPLY_MS + 1)).toBeNull();
  });

  test('no reply text (a read-only page): no reply bubble', () => {
    noteTurnFinished(1, T0);
    expect(speechFor(1, idle, undefined, T0 + 1000)).toBeNull();
  });

  test('Stuck? outranks a reply', () => {
    noteAgentNews(1, T0);
    noteTurnFinished(1, T0);
    expect(speechFor(1, running, 'old reply', T0 + 11 * 60_000)?.kind).toBe('stuck');
  });

  test('clipping never splits an emoji', () => {
    const text = `${'a'.repeat(46)}😀😀😀`;
    const clipped = clipSpeech(text);
    expect(Array.from(clipped)).toHaveLength(48);
    expect(clipped.endsWith('😀…')).toBe(true);
  });
});

describe('triage', () => {
  const rank = (r: Record<number, 0 | 1 | 2 | 3>) => (id: number) => r[id] ?? 3;

  test('needs you, then quiet, then working, then the rest; ties keep office order', () => {
    expect(triageOrder([1, 2, 3, 4, 5], rank({ 1: 3, 2: 2, 3: 0, 4: 1, 5: 2 }))).toEqual([
      3, 4, 2, 5, 1,
    ]);
  });

  test('steps forward and back, wrapping; starts at the top with nothing selected', () => {
    const s = new TriageStepper();
    const order = () => [3, 4, 2];
    expect(s.step(1, null, order, T0)).toBe(3);
    expect(s.step(1, 3, order, T0 + 10)).toBe(4);
    expect(s.step(-1, 3, order, T0 + 20)).toBe(2);
    expect(s.step(1, 2, order, T0 + 30)).toBe(3);
  });

  test('the order is frozen while stepping, and recomputed after a pause', () => {
    const s = new TriageStepper();
    let order = [3, 4, 2];
    s.step(1, null, () => order, T0);
    order = [2, 3, 4]; // agent 2 just asked for approval
    expect(s.step(1, 3, () => order, T0 + 100)).toBe(4);
    expect(s.step(1, 4, () => order, T0 + 200 + TRIAGE_FREEZE_MS)).toBe(2);
  });

  test('a departed agent drops out of the frozen order', () => {
    const s = new TriageStepper();
    s.step(1, null, () => [3, 4, 2], T0);
    expect(s.step(1, 3, () => [3, 2], T0 + 100)).toBe(2);
  });

  test('arrow keys in fields and the terminal are left alone', () => {
    const el = (tagName: string, extra: object = {}) =>
      ({
        tagName,
        isContentEditable: false,
        closest: () => null,
        ...extra,
      }) as unknown as EventTarget;
    expect(isEditableTarget(el('INPUT'))).toBe(true);
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(el('DIV', { closest: () => ({}) }))).toBe(true);
    expect(isEditableTarget(el('CANVAS'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
