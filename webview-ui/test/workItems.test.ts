import { describe, expect, test } from 'vitest';

import {
  clearWorkItems,
  getTreeChanges,
  getWorkItems,
  setTreeChanges,
  setWorkItems,
  treeChangesText,
} from '../src/office/workItems.js';

describe('workItems', () => {
  test('keeps each agent’s latest items and its project’s changes', () => {
    setWorkItems({
      type: 'agentWorkItems',
      id: 2,
      todos: [],
      files: ['src/a.ts'],
      title: 'Fix it',
    });
    setTreeChanges({
      type: 'workingTreeChanges',
      agents: [{ id: 2, files: 1, insertions: 4, deletions: 0 }],
    });
    expect(getWorkItems(2)?.files).toEqual(['src/a.ts']);
    expect(getTreeChanges(2)?.insertions).toBe(4);
    clearWorkItems(2);
    expect(getWorkItems(2)).toBeUndefined();
    expect(getTreeChanges(2)).toBeUndefined();
  });

  test('describes changes briefly', () => {
    expect(treeChangesText({ id: 1, files: 0, insertions: 0, deletions: 0 })).toBe(
      'No uncommitted changes',
    );
    expect(treeChangesText({ id: 1, files: 1, insertions: 3, deletions: 2 })).toBe(
      '1 file · +3 −2',
    );
    expect(treeChangesText({ id: 1, files: 4, insertions: 0, deletions: 9 })).toBe(
      '4 files · +0 −9',
    );
  });
});
