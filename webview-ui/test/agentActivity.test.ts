import { describe, expect, it } from 'vitest';

import {
  getActivityText,
  lifecycleAwareText,
  NEEDS_APPROVAL_TEXT,
  pendingApprovalTool,
  providerName,
} from '../src/office/agentActivity.js';

const tool = (toolId: string, status: string, done = false, permissionWait = false) => ({
  toolId,
  status,
  done,
  permissionWait,
});

describe('agent activity', () => {
  it('reports the running tool, approval, then idle', () => {
    const tools = { 1: [tool('a', 'Reading a.ts', true), tool('b', 'Running: npm test')] };
    expect(getActivityText(1, tools, true, null, false)).toBe('Running: npm test');
    expect(getActivityText(1, tools, true, 'permission', false)).toBe(NEEDS_APPROVAL_TEXT);
    expect(getActivityText(2, tools, false, null, false)).toBe('Idle');
  });

  it('names the tool awaiting approval', () => {
    const flagged = [tool('a', 'Editing x.ts'), tool('b', 'Running: rm -rf dist', false, true)];
    expect(pendingApprovalTool(flagged, false)?.status).toBe('Running: rm -rf dist');
    // A bubble-only permission falls back to the newest unfinished tool.
    const unflagged = [tool('a', 'Reading y.ts', true), tool('b', 'Running: git push')];
    expect(pendingApprovalTool(unflagged, true)?.status).toBe('Running: git push');
    expect(pendingApprovalTool(unflagged, false)).toBeUndefined();
  });

  it('derives the provider from the character label', () => {
    expect(providerName('Codex · Website')).toBe('Codex');
    expect(providerName('ApiServer')).toBe('Claude');
    expect(providerName(undefined)).toBe('Claude');
  });

  it('says Thinking mid-turn when no tool runs, instead of the stale last tool', () => {
    const done = [tool('a', 'Running: npm test', true)];
    expect(lifecycleAwareText('Running: npm test', done, 'thinking')).toBe('Thinking');
    expect(lifecycleAwareText('Running: npm test', [tool('b', 'Running: x')], 'thinking')).toBe(
      'Running: npm test',
    );
    expect(lifecycleAwareText('Idle', done, 'idle')).toBe('Idle');
  });
});
