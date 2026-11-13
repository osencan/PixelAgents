/* eslint-disable pixel-agents/no-inline-colors -- layout fixture colors, not UI styling */
import { expect, test } from 'vitest';

import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

function fixture() {
  const seat = { uid: 'desk', seatCol: 1, seatRow: 1, facingDir: Direction.DOWN, assigned: true };
  const ch = createCharacter(1, 0, 'desk', seat);
  ch.isActive = false;
  ch.state = CharacterState.TYPE;
  const tiles = Array.from({ length: 5 }, () => Array(7).fill(TileType.FLOOR_1));
  const floor = tiles.flatMap((row, r) => row.map((_, c) => ({ col: c, row: r })));
  const rest = [{ col: 5, row: 3 }];
  const blocked = new Set<string>();
  const tick = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30)
      updateCharacter(ch, 1 / 30, floor, new Map([['desk', seat]]), tiles, blocked, rest);
  };
  return { ch, rest, blocked, tick };
}

test('idle agent reaches rest room, stays there, and returns to original desk on activity', () => {
  const { ch, tick } = fixture();
  tick(15);
  expect([ch.tileCol, ch.tileRow, ch.state]).toEqual([5, 3, CharacterState.IDLE]);
  tick(120);
  expect([ch.tileCol, ch.tileRow]).toEqual([5, 3]);
  expect(ch.seatId).toBe('desk');
  ch.isActive = true;
  tick(15);
  expect([ch.tileCol, ch.tileRow, ch.state]).toEqual([1, 1, CharacterState.TYPE]);
});

test('activity interrupts the walk to the rest room', () => {
  const { ch, tick } = fixture();
  tick(0.5);
  ch.isActive = true;
  tick(15);
  expect([ch.tileCol, ch.tileRow, ch.state]).toEqual([1, 1, CharacterState.TYPE]);
});

test('an unreachable rest area does not teleport the agent', () => {
  const { ch, blocked, tick } = fixture();
  for (let row = 0; row < 5; row++) blocked.add(`3,${row}`);
  tick(20);
  expect(ch.tileCol).toBeLessThan(3);
});

test('a missing rest room keeps the original behavior available', () => {
  const { ch, rest, tick } = fixture();
  rest.length = 0;
  tick(1);
  expect(ch.seatId).toBe('desk');
  expect(Number.isFinite(ch.x)).toBe(true);
});

import { OfficeState } from '../src/office/engine/officeState.js';

test('office selects Blue Room, and an explicit Rest Room overrides it', () => {
  for (const explicit of [false, true]) {
    const tiles = Array(35).fill(TileType.FLOOR_1);
    const areaTiles: (string | null)[] = Array(35).fill(null);
    areaTiles[3 * 7 + 5] = 'Blue Room';
    if (explicit) areaTiles[3 * 7 + 4] = 'Rest Room';
    const office = new OfficeState({
      version: 1,
      cols: 7,
      rows: 5,
      tiles,
      furniture: [],
      areas: [
        { label: 'Blue Room', color: '#248bf9' },
        ...(explicit ? [{ label: 'Rest Room', color: '#ffffff' }] : []),
      ],
      areaTiles,
    });
    const ch = createCharacter(1, 0, null, null);
    ch.isActive = false;
    ch.matrixEffect = null;
    office.characters.set(1, ch);
    for (let i = 0; i < 900; i++) office.update(1 / 30);
    expect([ch.tileCol, ch.tileRow]).toEqual([explicit ? 4 : 5, 3]);
  }
});
