/**
 * Room purposes: which Areas idle, waiting and planning agents use, and how.
 * Behavior keys on `AreaDefinition.purpose`, so renaming a room never changes
 * what it is for.
 */
import {
  LEGACY_REST_AREA_LABEL,
  REST_AREA_LABEL_PATTERN,
  ROOM_SLEEP_AFTER_MIN_DEFAULT,
} from '../constants.js';
import type { AreaDefinition, AreaPurpose, OfficeLayout, RoomPolicy } from './types.js';

export const AREA_PURPOSES: readonly AreaPurpose[] = ['work', 'rest', 'waiting', 'planning'];

export const AREA_PURPOSE_LABELS: Record<AreaPurpose, string> = {
  work: 'Work',
  rest: 'Rest',
  waiting: 'Waiting',
  planning: 'Planning',
};

/** An area's purpose; legacy Rest-named areas without one count as rest. */
export function areaPurpose(area: AreaDefinition): AreaPurpose {
  return area.purpose ?? (REST_AREA_LABEL_PATTERN.test(area.label.trim()) ? 'rest' : 'work');
}

/** Labels of the areas with this purpose. With no rest area at all, the
 *  original layout's Blue Room keeps serving as one. */
export function areaLabelsFor(layout: OfficeLayout, purpose: AreaPurpose): Set<string> {
  const areas = layout.areas ?? [];
  const labels = new Set(areas.filter((a) => areaPurpose(a) === purpose).map((a) => a.label));
  if (
    purpose === 'rest' &&
    labels.size === 0 &&
    areas.some((a) => a.label === LEGACY_REST_AREA_LABEL)
  ) {
    labels.add(LEGACY_REST_AREA_LABEL);
  }
  return labels;
}

export function resolveRoomPolicy(layout: OfficeLayout): Required<RoomPolicy> {
  return {
    sleepAfterMin: layout.roomPolicy?.sleepAfterMin ?? ROOM_SLEEP_AFTER_MIN_DEFAULT,
    waitingMode: layout.roomPolicy?.waitingMode ?? 'badge',
  };
}
