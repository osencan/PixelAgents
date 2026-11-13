import { describe, expect, it } from 'vitest';

import {
  clearFilter,
  isFilteredOut,
  projectOfLabel,
  toggleProject,
  toggleProvider,
} from '../src/office/agentFilter.js';
import { OfficeState } from '../src/office/engine/officeState.js';

describe('agent filter', () => {
  it('reads the project out of Claude and Codex labels', () => {
    expect(projectOfLabel('Website')).toBe('Website');
    expect(projectOfLabel('Codex · site (clients) · subagent')).toBe('site (clients)');
    expect(projectOfLabel(undefined)).toBe('Unknown project');
  });

  it('filters by provider and project, and clears', () => {
    toggleProject('ApiServer');
    expect(isFilteredOut('ApiServer')).toBe(true);
    expect(isFilteredOut('Codex · ApiServer')).toBe(true);
    expect(isFilteredOut('MarketingSite')).toBe(false);
    toggleProvider('Codex');
    expect(isFilteredOut('Codex · MarketingSite')).toBe(true);
    clearFilter();
    expect(isFilteredOut('ApiServer')).toBe(false);
    expect(isFilteredOut('Codex · MarketingSite')).toBe(false);
  });

  it('changes visibility only: a filtered agent keeps its character and seat', () => {
    const office = new OfficeState();
    office.addAgent(3, 0, 0, undefined, true, 'ApiServer');
    const seatBefore = office.characters.get(3)?.seatId;
    toggleProject('ApiServer');
    expect(office.isHidden(3)).toBe(true);
    expect(office.characters.get(3)?.seatId).toBe(seatBefore);
    expect(office.getVisibleCharacters().some((c) => c.id === 3)).toBe(false);
    clearFilter();
    expect(office.isHidden(3)).toBe(false);
  });
});
