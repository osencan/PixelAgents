 
import { describe, expect, it } from 'vitest';

import { CHECK_RESULT_SHOW_MS, PROJECT_ACCENT_COLORS } from '../src/constants.js';
import { getAgentRole, setAgentRole } from '../src/office/agentRoles.js';
import { ambientTint } from '../src/office/ambient.js';
import { activeCheckResult, checkText, showCheckResult } from '../src/office/checkResults.js';
import { clearAgentKey, setAgentKey } from '../src/office/hiddenAgents.js';
import { projectAccent, rememberedSeat, rememberSeat } from '../src/office/projectPrefs.js';

describe('project accents', () => {
  it('give each project a stable accent from the palette, shared by its Codex sessions', () => {
    expect(PROJECT_ACCENT_COLORS).toContain(projectAccent('Website'));
    expect(projectAccent('Website')).toBe(projectAccent('Website'));
    expect(projectAccent('Codex · Website · subagent')).toBe(projectAccent('Website'));
  });
});

describe('seat memory', () => {
  it('remembers the desk per project, including across providers', () => {
    rememberSeat('ApiServer', 'desk-3');
    expect(rememberedSeat('ApiServer')).toBe('desk-3');
    expect(rememberedSeat('Codex · ApiServer')).toBe('desk-3');
    expect(rememberedSeat('Other')).toBeUndefined();
  });
});

describe('role badges', () => {
  it('are keyed by session, so a restart that changes the numeric id keeps them', () => {
    setAgentKey(1, 'claude:role0001');
    setAgentRole(1, '  reviewer  ');
    expect(getAgentRole(1)).toBe('reviewer');
    clearAgentKey(1);
    setAgentKey(9, 'claude:role0001');
    expect(getAgentRole(9)).toBe('reviewer');
    setAgentRole(9, '');
    expect(getAgentRole(9)).toBeUndefined();
  });
});

describe('ambient tint', () => {
  it('is night late, warm at the edges of the day, and absent in daytime', () => {
    expect(ambientTint(23)).not.toBeNull();
    expect(ambientTint(3)).toBe(ambientTint(23));
    expect(ambientTint(19)).not.toBe(ambientTint(23));
    expect(ambientTint(7)).toBe(ambientTint(19));
    expect(ambientTint(12)).toBeNull();
  });
});

describe('check results', () => {
  it('show briefly with text, not color alone', () => {
    showCheckResult(4, 'build', false, 1000);
    expect(activeCheckResult(4, 1000 + CHECK_RESULT_SHOW_MS - 1)?.ok).toBe(false);
    expect(activeCheckResult(4, 1000 + CHECK_RESULT_SHOW_MS + 1)).toBeUndefined();
    expect(checkText('test', true)).toBe('Tests passed');
    expect(checkText('build', false)).toBe('Build failed');
  });
});
