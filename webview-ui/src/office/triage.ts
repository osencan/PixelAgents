/**
 * Keyboard triage: Alt+Down / Alt+Up step through the office's agents, those
 * that need you first (an approval request), then quiet ones ("Stuck?"), then
 * working ones, then the rest. While you keep stepping the order is frozen, so
 * an agent changing state doesn't make the next press skip or repeat.
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import { TRIAGE_FREEZE_MS } from '../constants.js';

/** Lower comes first. */
export type TriageRank = 0 | 1 | 2 | 3;

/** Stable order by rank; ties keep the office's own order. */
export function triageOrder(ids: readonly number[], rank: (id: number) => TriageRank): number[] {
  return ids
    .map((id, i) => ({ id, i, r: rank(id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.id);
}

export class TriageStepper {
  private order: number[] = [];
  private lastStepAt = -Infinity;

  /** The agent to select after `current`, or undefined when there are none. */
  step(
    direction: 1 | -1,
    current: number | null,
    compute: () => number[],
    now: number,
  ): number | undefined {
    const fresh = compute();
    // Keep the frozen order while stepping, minus agents that left.
    if (now - this.lastStepAt > TRIAGE_FREEZE_MS) {
      this.order = fresh;
    } else {
      const present = new Set(fresh);
      this.order = [
        ...this.order.filter((id) => present.has(id)),
        ...fresh.filter((id) => !this.order.includes(id)),
      ];
    }
    this.lastStepAt = now;
    if (!this.order.length) return undefined;
    const at = current === null ? -1 : this.order.indexOf(current);
    if (at === -1) return direction === 1 ? this.order[0] : this.order[this.order.length - 1];
    return this.order[(at + direction + this.order.length) % this.order.length];
  }
}

/** Typing somewhere (a field, the terminal): arrow keys belong to it. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    !!el.closest?.('.xterm')
  );
}
