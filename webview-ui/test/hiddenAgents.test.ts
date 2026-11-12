import { describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import {
  clearAgentKey,
  hiddenAgentIds,
  isAgentHidden,
  setAgentHidden,
  setAgentKey,
} from '../src/office/hiddenAgents.js';

describe('hidden agents', () => {
  it('hides by stable key, so a new numeric id for the same session stays hidden', () => {
    setAgentKey(1, 'claude:aaaa');
    setAgentHidden(1, true);
    expect(isAgentHidden(1)).toBe(true);
    // Server restart: the same session returns under another id.
    clearAgentKey(1);
    setAgentKey(5, 'claude:aaaa');
    expect(isAgentHidden(5)).toBe(true);
    expect(hiddenAgentIds()).toEqual([5]);
    setAgentHidden(5, false);
    expect(isAgentHidden(5)).toBe(false);
  });

  it('keeps a hidden agent simulated but out of drawing and hit-testing', () => {
    const office = new OfficeState();
    office.addAgent(7, 0, 0, undefined, true, 'Website');
    setAgentKey(7, 'claude:bbbb');
    const ch = office.characters.get(7)!;
    const hitY = ch.y - 4;
    expect(office.getCharacterAt(ch.x, hitY)).toBe(7);

    setAgentHidden(7, true);
    expect(office.characters.has(7)).toBe(true);
    expect(office.getVisibleCharacters().some((c) => c.id === 7)).toBe(false);
    expect(office.getCharacterAt(ch.x, hitY)).toBeNull();

    setAgentHidden(7, false);
    expect(office.getVisibleCharacters().some((c) => c.id === 7)).toBe(true);
  });
});
