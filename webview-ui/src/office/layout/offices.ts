import type { OfficeLayout } from '../types.js';
import blueOffice from './offices/blue-office.json';
import fourRooms from './offices/four-rooms.json';
import severance from './offices/severance.json';
import twoRooms from './offices/two-rooms.json';

/**
 * Ready-made offices offered in Layout → Offices. Four Rooms is also the
 * bundled default (`public/assets/default-layout-1.json` holds the same
 * layout; `offices.test.ts` keeps them equal). Blue Office and Severance come
 * from Pablo De Lucca's layout index (pixel-agents-hq/index, MIT).
 */
export interface OfficePreset {
  id: string;
  name: string;
  description: string;
  layout: OfficeLayout;
}

export const DEFAULT_OFFICE_ID = 'four-rooms';

export const OFFICES: readonly OfficePreset[] = [
  {
    id: 'four-rooms',
    name: 'Four Rooms',
    description: 'Four walled rooms: a waiting room, two work rooms and a rest room.',
    layout: fourRooms as unknown as OfficeLayout,
  },
  {
    id: 'two-rooms',
    name: 'Two Rooms',
    description: 'Two rooms side by side, the original Pixel Agents office.',
    layout: twoRooms as unknown as OfficeLayout,
  },
  {
    id: 'blue-office',
    name: 'Blue Office',
    description: 'An open-plan office in cool blues, in four named areas.',
    layout: blueOffice as unknown as OfficeLayout,
  },
  {
    id: 'severance',
    name: 'Severance',
    description: 'One sparse, symmetrical floor with a single cluster of desks.',
    layout: severance as unknown as OfficeLayout,
  },
];

/**
 * The layout that switching to `office` gives: its tiles, furniture and rooms,
 * keeping what belongs to the user rather than to the floor plan (pets, room
 * behaviour) and the current revision, so the server never mistakes it for an
 * outdated bundled default.
 */
export function layoutForOffice(office: OfficePreset, current: OfficeLayout): OfficeLayout {
  const next: OfficeLayout = { ...structuredClone(office.layout), pets: current.pets ?? [] };
  if (current.layoutRevision !== undefined) next.layoutRevision = current.layoutRevision;
  if (current.roomPolicy) next.roomPolicy = current.roomPolicy;
  return next;
}

/** The office a layout's floor plan is, if it is one of OFFICES unedited. */
export function officeIdOf(layout: OfficeLayout): string | null {
  const tiles = JSON.stringify(layout.tiles);
  const furniture = JSON.stringify(layout.furniture);
  const match = OFFICES.find(
    (o) =>
      o.layout.cols === layout.cols &&
      o.layout.rows === layout.rows &&
      JSON.stringify(o.layout.tiles) === tiles &&
      JSON.stringify(o.layout.furniture) === furniture,
  );
  return match?.id ?? null;
}
