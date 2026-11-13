/* eslint-disable pixel-agents/no-inline-colors -- layout fixture colors, not UI styling */
import { afterEach, describe, expect, it } from 'vitest';

import { clearAgentLifecycle, setAgentLifecycle } from '../src/office/agentLifecycles.js';
import {
  renameArea,
  setAreaPurpose,
  updateRoomPolicy,
} from '../src/office/editor/editorActions.js';
import { createCharacter } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { deserializeLayout } from '../src/office/layout/layoutSerializer.js';
import { areaLabelsFor, resolveRoomPolicy } from '../src/office/roomPolicy.js';
import type { AreaDefinition, OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const COLS = 9;
const ROWS = 5;

/** Open floor; columns 6-7 of row 2 are the rest room, columns 6-7 of row 4 the waiting room. */
function layout(extra: Partial<OfficeLayout> = {}): OfficeLayout {
  const tiles = Array(COLS * ROWS).fill(TileType.FLOOR_1);
  const areaTiles: (string | null)[] = Array(COLS * ROWS).fill(null);
  areaTiles[2 * COLS + 6] = 'Lounge';
  areaTiles[2 * COLS + 7] = 'Lounge';
  areaTiles[4 * COLS + 6] = 'Queue';
  areaTiles[4 * COLS + 7] = 'Queue';
  const areas: AreaDefinition[] = [
    { label: 'Lounge', color: '#ffffff', purpose: 'rest' },
    { label: 'Queue', color: '#000000', purpose: 'waiting' },
  ];
  return { version: 1, cols: COLS, rows: ROWS, tiles, furniture: [], areas, areaTiles, ...extra };
}

function addIdle(office: OfficeState, id: number) {
  const ch = createCharacter(id, 0, null, null);
  ch.isActive = false;
  ch.matrixEffect = null;
  office.characters.set(id, ch);
  return ch;
}

const run = (office: OfficeState, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) office.update(1 / 30);
};
const tileOf = (ch: { tileCol: number; tileRow: number }) => `${ch.tileCol},${ch.tileRow}`;

afterEach(() => {
  for (const id of [1, 2, 3]) clearAgentLifecycle(id);
});

describe('room purposes', () => {
  it('migrates Rest-named areas to purpose rest, and a rename keeps it', () => {
    const legacy = deserializeLayout(
      JSON.stringify({
        ...layout(),
        areas: [
          { label: 'Rest Room', color: '#ffffff' },
          { label: 'Office', color: '#000000' },
        ],
      }),
    )!;
    expect(legacy.areas?.map((a) => a.purpose)).toEqual(['rest', undefined]);
    const renamed = renameArea(legacy, 'Rest Room', 'Chill Zone');
    expect(areaLabelsFor(renamed, 'rest')).toEqual(new Set(['Chill Zone']));
    // Purpose, not the name, decides: a room called "Rest" set to work is not a rest room.
    const repurposed = setAreaPurpose(renamed, 'Chill Zone', 'work');
    expect(areaLabelsFor(repurposed, 'rest').size).toBe(0);
  });

  it('gives each idle agent its own rest tile, and a full room leaves the extra at its spot', () => {
    const office = new OfficeState(layout());
    const chars = [addIdle(office, 1), addIdle(office, 2), addIdle(office, 3)];
    run(office, 20);
    // Two agents hold the two room tiles and stand on them; the third holds
    // none (it keeps the normal idle behavior, which may wander, so where it
    // stands at any instant is not asserted).
    const holders = chars.filter((c) => office.roomReservation(c.id));
    expect(holders).toHaveLength(2);
    expect(new Set(holders.map(tileOf))).toEqual(new Set(['6,2', '7,2']));
    for (const c of holders) {
      const r = office.roomReservation(c.id)!;
      expect(tileOf(c)).toBe(`${r.col},${r.row}`);
    }
  });

  it('sends only a confirmed permission wait to the waiting room, and only in that mode', () => {
    const office = new OfficeState(updateRoomPolicy(layout(), { waitingMode: 'area' }));
    const ch = addIdle(office, 1);
    ch.isActive = true;
    setAgentLifecycle(1, {
      lifecycle: 'running',
      observed: true,
      permissionSuspected: true,
      since: 0,
    });
    run(office, 10);
    expect(office.roomReservation(1)).toBeUndefined();

    setAgentLifecycle(1, {
      lifecycle: 'waiting_permission',
      observed: true,
      permissionSuspected: false,
      since: 0,
    });
    run(office, 20);
    expect(['6,4', '7,4']).toContain(tileOf(ch));
    expect(office.roomReservation(1)?.purpose).toBe('waiting');

    // Approved: it is released and goes back to work.
    setAgentLifecycle(1, {
      lifecycle: 'running',
      observed: true,
      permissionSuspected: false,
      since: 0,
    });
    run(office, 1);
    expect(office.roomReservation(1)).toBeUndefined();

    // Badge mode (the default) never moves anyone.
    const badge = new OfficeState(layout());
    const other = addIdle(badge, 2);
    other.isActive = true;
    setAgentLifecycle(2, {
      lifecycle: 'waiting_permission',
      observed: true,
      permissionSuspected: false,
      since: 0,
    });
    run(badge, 10);
    expect(badge.roomReservation(2)).toBeUndefined();
    expect(resolveRoomPolicy(layout()).waitingMode).toBe('badge');
  });

  it('sleeps only after the delay of reported idle, settled in the rest room', () => {
    const office = new OfficeState(layout());
    addIdle(office, 1);
    run(office, 20);
    const now = Date.now();
    setAgentLifecycle(1, {
      lifecycle: 'idle',
      observed: true,
      permissionSuspected: false,
      since: now - 60_000,
    });
    expect(office.isAsleep(1, now)).toBe(false);
    setAgentLifecycle(1, {
      lifecycle: 'idle',
      observed: true,
      permissionSuspected: false,
      since: now - 6 * 60_000,
    });
    expect(office.isAsleep(1, now)).toBe(true);
    // A guessed idle never puts anyone to sleep.
    setAgentLifecycle(1, {
      lifecycle: 'idle',
      observed: false,
      permissionSuspected: false,
      since: now - 6 * 60_000,
    });
    expect(office.isAsleep(1, now)).toBe(false);
    // Sleep can be turned off.
    const never = new OfficeState(updateRoomPolicy(layout(), { sleepAfterMin: 0 }));
    addIdle(never, 2);
    run(never, 20);
    setAgentLifecycle(2, {
      lifecycle: 'idle',
      observed: true,
      permissionSuspected: false,
      since: now - 60 * 60_000,
    });
    expect(never.isAsleep(2, now)).toBe(false);
  });

  it('new activity releases the rest tile at once', () => {
    const office = new OfficeState(layout());
    const ch = addIdle(office, 1);
    run(office, 0.3);
    expect(office.roomReservation(1)?.purpose).toBe('rest');
    ch.isActive = true;
    run(office, 1 / 30);
    expect(office.roomReservation(1)).toBeUndefined();
  });
});

describe('room spacing', () => {
  it('leaves an empty tile between resting agents while the room has space', () => {
    const tiles = Array(COLS * ROWS).fill(TileType.FLOOR_1);
    const areaTiles: (string | null)[] = Array(COLS * ROWS).fill(null);
    for (let c = 2; c <= 7; c++) areaTiles[2 * COLS + c] = 'Lounge';
    const office = new OfficeState({
      version: 1,
      cols: COLS,
      rows: ROWS,
      tiles,
      furniture: [],
      areas: [{ label: 'Lounge', color: '#ffffff', purpose: 'rest' }],
      areaTiles,
    });
    for (const id of [1, 2, 3]) addIdle(office, id);
    run(office, 20);
    const cols = [1, 2, 3].map((id) => office.roomReservation(id)!.col).sort((a, b) => a - b);
    for (let i = 1; i < cols.length; i++) expect(cols[i] - cols[i - 1]).toBeGreaterThanOrEqual(2);
  });
});

describe('newly created idle agents', () => {
  it('go to the rest room when the server reports them idle, without a reload', () => {
    const office = new OfficeState(layout());
    office.addAgent(5, 0, 0, undefined, true, 'Website');
    const ch = office.characters.get(5)!;
    ch.matrixEffect = null;
    expect(ch.isActive).toBe(true); // every character starts active
    office.applyLifecycle(5, 'running');
    expect(ch.isActive).toBe(true);
    office.applyLifecycle(5, 'idle');
    expect(ch.isActive).toBe(false);
    run(office, 20);
    expect(office.roomReservation(5)?.purpose).toBe('rest');
    expect(['6,2', '7,2']).toContain(`${ch.tileCol},${ch.tileRow}`);
  });
});

describe('planning room', () => {
  it('takes agents Claude reports in plan mode, and releases them when planning ends', () => {
    const base = layout();
    const withPlanning = {
      ...base,
      areas: [...base.areas!, { label: 'Board', color: '#00ff00', purpose: 'planning' as const }],
      areaTiles: base.areaTiles!.map((t, i) =>
        i === 0 * COLS + 7 || i === 0 * COLS + 8 ? 'Board' : t,
      ),
    };
    const office = new OfficeState(withPlanning);
    const ch = addIdle(office, 1);
    ch.isActive = true;
    setAgentLifecycle(1, {
      lifecycle: 'planning',
      observed: true,
      permissionSuspected: false,
      since: 0,
    });
    run(office, 20);
    expect(office.roomReservation(1)?.purpose).toBe('planning');
    expect(['7,0', '8,0']).toContain(`${ch.tileCol},${ch.tileRow}`);
    setAgentLifecycle(1, {
      lifecycle: 'editing',
      observed: true,
      permissionSuspected: false,
      since: 0,
    });
    run(office, 1);
    expect(office.roomReservation(1)).toBeUndefined();
  });
});
