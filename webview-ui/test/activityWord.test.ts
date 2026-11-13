import { describe, expect, it } from 'vitest';

import { activityWord } from '../src/office/agentActivity.js';

describe('activityWord (compact subtask labels)', () => {
  it('keeps only the activity verb', () => {
    expect(activityWord('Running: npm test -- --watch')).toBe('Running');
    expect(activityWord('Reading app.ts')).toBe('Reading');
    expect(activityWord('Searching code')).toBe('Searching');
    expect(activityWord('Waiting for your answer')).toBe('Waiting');
    expect(activityWord('Running: make · approval?')).toBe('Running');
  });

  it('keeps short fixed phrases whole', () => {
    expect(activityWord('Idle')).toBe('Idle');
    expect(activityWord('Thinking')).toBe('Thinking');
    expect(activityWord('Needs approval')).toBe('Needs approval');
    expect(activityWord('No recent activity')).toBe('No recent activity');
  });
});
