/* eslint-disable pixel-agents/no-inline-colors -- layout fixture colors, not UI styling */
/**
 * A working agent sits at a work desk: seats in Rest, Waiting and Planning
 * rooms are a last resort. Reported 2026-11-16: an agent was working in the
 * rest room while rooms no Directory was mapped to had free desks.
 */
import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { AreaDefinition, OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

beforeAll(() => {
  const chair: CatalogAsset = {
    id: 'TEST_CHAIR',
    label: 'chair',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  assert.ok(buildDynamicCatalog({ catalog: [chair], sprites: { TEST_CHAIR: [['c']] } }));
});

const COLS = 8;
const ROWS = 6;

/** Chair `rest` in the Lounge (rest), chair `work` in Room B (work, mapped to no Directory). */
function layout(workChair = true): OfficeLayout {
  const areaTiles: (string | null)[] = Array(COLS * ROWS).fill(null);
  for (let c = 0; c < 4; c++) for (let r = 0; r < ROWS; r++) areaTiles[r * COLS + c] = 'Lounge';
  for (let c = 4; c < COLS; c++) for (let r = 0; r < ROWS; r++) areaTiles[r * COLS + c] = 'Room B';
  const areas: AreaDefinition[] = [
    { label: 'Lounge', color: '#ffffff', purpose: 'rest' },
    { label: 'Room B', color: '#000000' },
  ];
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles: new Array<TileType>(COLS * ROWS).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'rest', type: 'TEST_CHAIR', col: 1, row: 1 },
      ...(workChair ? [{ uid: 'work', type: 'TEST_CHAIR', col: 5, row: 1 }] : []),
    ],
    areas,
    areaTiles,
  };
}

describe('work seats', () => {
  test('a new agent takes the work desk in an unmapped room, not the rest room', () => {
    const os = new OfficeState(layout());
    assert.equal(os.isWorkSeat('rest'), false);
    assert.equal(os.isWorkSeat('work'), true);
    os.addAgent(1, 0, 0, undefined, true, 'ApiServer');
    assert.equal(os.characters.get(1)!.seatId, 'work');
  });

  test('a remembered rest-room seat is declined while a work desk is free', () => {
    const os = new OfficeState(layout());
    os.addAgent(1, 0, 0, 'rest', true, 'ApiServer');
    assert.equal(os.characters.get(1)!.seatId, 'work');
  });

  test('with no work desk left, the rest room still seats it', () => {
    const os = new OfficeState(layout(false));
    os.addAgent(1, 0, 0, undefined, true, 'ApiServer');
    assert.equal(os.characters.get(1)!.seatId, 'rest');
  });

  test('a layout rebuild moves a rest-room sitter to a free work desk', () => {
    const os = new OfficeState(layout(false));
    os.addAgent(1, 0, 0, undefined, true, 'ApiServer');
    assert.equal(os.characters.get(1)!.seatId, 'rest');
    os.rebuildFromLayout(layout(true));
    assert.equal(os.characters.get(1)!.seatId, 'work');
    assert.equal(os.seats.get('rest')!.assigned, false);
  });

  test('a rebuild keeps the rest-room sitter where it is when no work desk is free', () => {
    const os = new OfficeState(layout(false));
    os.addAgent(1, 0, 0, undefined, true, 'ApiServer');
    os.rebuildFromLayout(layout(false));
    assert.equal(os.characters.get(1)!.seatId, 'rest');
  });
});
