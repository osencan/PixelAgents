import { describe, expect, test } from 'vitest';

import {
  agentUsageToday,
  formatTokens,
  projectUsageToday,
  setUsageToday,
  sumModels,
  tokenTotal,
} from '../src/office/usageToday.js';

const models = [
  { model: 'a', input: 10, output: 20, cacheRead: 1000, cacheWrite: 5 },
  { model: 'b', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
];

describe('usageToday', () => {
  test('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
    expect(formatTokens(250_000_000)).toBe('250M');
    expect(formatTokens(1_200_000_000)).toBe('1.2B');
  });

  test('totals add every kind once', () => {
    expect(tokenTotal(models)).toBe(1038);
    expect(sumModels(models)).toEqual({ input: 11, output: 22, cacheRead: 1000, cacheWrite: 5 });
  });

  test('looks agents and projects up from the last message', () => {
    setUsageToday({
      type: 'usageToday',
      day: '2026-11-16',
      agents: [{ id: 3, models, compactions: 2, project: 'ApiServer' }],
      projects: [{ name: 'ApiServer', models }],
    });
    expect(agentUsageToday(3)?.compactions).toBe(2);
    expect(agentUsageToday(4)).toBeUndefined();
    expect(projectUsageToday('ApiServer')?.models).toHaveLength(2);
    expect(projectUsageToday(undefined)).toBeUndefined();
  });
});
