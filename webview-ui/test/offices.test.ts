/**
 * Layout → Offices: every ready-made office is a well-formed layout, Four
 * Rooms is the bundled default, and switching offices keeps what is the
 * user's (pets, room behaviour, the layout revision).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'vitest';

import {
  DEFAULT_OFFICE_ID,
  layoutForOffice,
  officeIdOf,
  OFFICES,
} from '../src/office/layout/offices.js';
import type { OfficeLayout } from '../src/office/types.js';

const DEFAULT_LAYOUT_PATH = path.join(__dirname, '../public/assets/default-layout-1.json');

function office(id: string) {
  const found = OFFICES.find((o) => o.id === id);
  assert.ok(found, `no office ${id}`);
  return found;
}

test('every office is a well-formed layout with unique ids', () => {
  assert.equal(new Set(OFFICES.map((o) => o.id)).size, OFFICES.length);
  for (const { id, layout } of OFFICES) {
    const cells = layout.cols * layout.rows;
    assert.equal(layout.version, 1, id);
    assert.equal(layout.tiles.length, cells, `${id} tiles`);
    assert.equal(layout.tileColors?.length, cells, `${id} tileColors`);
    assert.ok(layout.furniture.length > 0, `${id} furniture`);
    if (layout.areaTiles) {
      assert.equal(layout.areaTiles.length, cells, `${id} areaTiles`);
      const labels = new Set((layout.areas ?? []).map((a) => a.label));
      for (const label of layout.areaTiles) {
        if (label !== null) assert.ok(labels.has(label), `${id}: unknown area ${label}`);
      }
    }
  }
});

test('Four Rooms is the bundled default layout, at revision 1', () => {
  const bundled = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT_PATH, 'utf8')) as OfficeLayout;
  // Bumping the revision would replace every existing user's saved office.
  assert.equal(bundled.layoutRevision, 1);
  assert.deepEqual(
    { ...bundled, layoutRevision: undefined },
    {
      ...office(DEFAULT_OFFICE_ID).layout,
      layoutRevision: undefined,
    },
  );
  assert.equal(officeIdOf(bundled), DEFAULT_OFFICE_ID);
});

test('switching offices keeps pets, room behaviour and the revision', () => {
  const current: OfficeLayout = {
    ...structuredClone(office('four-rooms').layout),
    layoutRevision: 1,
    pets: [{ id: 'cat', petType: 0 }],
    roomPolicy: { sleepAfterMin: 5, waitingMode: 'area' },
  };
  const next = layoutForOffice(office('severance'), current);
  assert.equal(officeIdOf(next), 'severance');
  assert.deepEqual(next.pets, current.pets);
  assert.deepEqual(next.roomPolicy, current.roomPolicy);
  assert.equal(next.layoutRevision, 1);
  // A copy: editing the new office never edits the preset.
  next.furniture.pop();
  assert.notEqual(next.furniture.length, office('severance').layout.furniture.length);
});

test('an edited office is no longer recognized as the preset', () => {
  const edited = structuredClone(office('two-rooms').layout);
  edited.furniture = edited.furniture.slice(1);
  assert.equal(officeIdOf(edited), null);
});
