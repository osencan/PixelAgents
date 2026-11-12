/* eslint-disable pixel-agents/no-inline-colors -- layout fixture colors, not UI styling */
import { expect, test } from 'vitest';

import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { renderAreaLabels } from '../src/office/engine/renderer.js';
import { TILE_SIZE } from '../src/office/types.js';
test('room label is centered horizontally, one row above its bottom floor row', () => {
  const drawn: { text: string; x: number; y: number }[] = [];
  const ctx = {
    save() {},
    restore() {},
    fillText(text: string, x: number, y: number) {
      drawn.push({ text, x, y });
    },
  } as unknown as CanvasRenderingContext2D;
  const tiles = Array<string | null>(30).fill(null);
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) tiles[r * 5 + c] = 'Blue Room';
  tiles[5 * 5 + 2] = 'Blue Room'; // Stray paint must not drag the label outside the room.
  renderAreaLabels(ctx, tiles, [{ label: 'Blue Room', color: '#248bf9' }], 5, 6, 10, 20, 2);
  expect(drawn[1]).toEqual({
    text: 'Blue Room',
    x: 10 + 2.5 * TILE_SIZE * 2,
    y: 20 + 2.5 * TILE_SIZE * 2,
  });
});
test('reconnect updates a reused agent ID to the authoritative directory name', () => {
  const office = new OfficeState();
  office.addAgent(7, 0, 0, undefined, true, 'Website');
  reconcileExistingAgents(office, [7], {}, { 7: 'ApiServer' }, true, []);
  expect(office.characters.get(7)?.directoryName).toBe('ApiServer');
  reconcileExistingAgents(office, [7], {}, {}, true, []);
  expect(office.characters.get(7)?.directoryName).toBeUndefined();
});
test('a one-row room keeps its label inside the room', () => {
  const drawn: { text: string; y: number }[] = [];
  const ctx = {
    save() {},
    restore() {},
    fillText(text: string, _x: number, y: number) {
      drawn.push({ text, y });
    },
  } as unknown as CanvasRenderingContext2D;
  const tiles = Array<string | null>(9).fill(null);
  for (let c = 0; c < 3; c++) tiles[3 + c] = 'Hall';
  renderAreaLabels(ctx, tiles, [{ label: 'Hall', color: '#ffffff' }], 3, 3, 0, 0, 1);
  expect(drawn[1].y).toBe(1.5 * TILE_SIZE);
});
