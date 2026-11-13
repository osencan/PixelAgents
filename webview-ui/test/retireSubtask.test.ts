/* eslint-disable pixel-agents/no-inline-colors -- layout fixture colors, not UI styling */
import { expect, test } from 'vitest';

import { RETIRE_MAX_SEC } from '../src/constants.js';
import { createCharacter } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { TileType } from '../src/office/types.js';

/** A 7x5 floor with a one-tile Rest Room at (5,3), or none. */
function office(withRest: boolean) {
  const tiles = Array(35).fill(TileType.FLOOR_1);
  const areaTiles: (string | null)[] = Array(35).fill(null);
  if (withRest) areaTiles[3 * 7 + 5] = 'Rest Room';
  const os = new OfficeState({
    version: 1,
    cols: 7,
    rows: 5,
    tiles,
    furniture: [],
    areas: withRest ? [{ label: 'Rest Room', color: '#ffffff' }] : [],
    areaTiles,
  });
  const ch = createCharacter(1, 0, null, null);
  ch.isActive = true;
  ch.isSubtask = true;
  ch.matrixEffect = null;
  os.characters.set(1, ch);
  const tick = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
  };
  return { os, ch, tick };
}

test('a finished subtask walks to the rest room and vanishes there, not before', () => {
  const { os, ch, tick } = office(true);
  os.retireAgent(1);
  expect(ch.isActive).toBe(false);
  tick(0.2);
  // On its way: still here, not yet despawning.
  expect(os.characters.has(1)).toBe(true);
  expect(ch.matrixEffect).not.toBe('despawn');
  tick(15);
  // Arrived at the rest tile, then dematerialized and was dropped.
  expect(os.characters.has(1)).toBe(false);
});

test('with no rest room it vanishes where it is', () => {
  const { os, ch, tick } = office(false);
  const [col, row] = [ch.tileCol, ch.tileRow];
  os.retireAgent(1);
  tick(1 / 30);
  expect(ch.matrixEffect).toBe('despawn');
  expect([ch.tileCol, ch.tileRow]).toEqual([col, row]);
});

test('an unreachable rest room does not keep it forever', () => {
  const { os, tick } = office(true);
  os.blockedTiles.add('5,3');
  for (let row = 0; row < 5; row++) os.blockedTiles.add(`4,${row}`);
  os.retireAgent(1);
  tick(RETIRE_MAX_SEC + 3);
  expect(os.characters.has(1)).toBe(false);
});
