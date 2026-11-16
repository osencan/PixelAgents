/**
 * Tokens used today, as the server reads them from local Claude and Codex
 * logs (usageToday). Account data: only tokened pages receive it, so a
 * read-only page simply has none. Counts only; there is no cost estimate.
 */
import type {
  AgentUsageToday,
  ModelTokenCounts,
  ProjectUsageToday,
  UsageToday,
} from '../../../core/src/messages.js';

let current: UsageToday | undefined;

export function setUsageToday(message: UsageToday): void {
  current = message;
}

export function agentUsageToday(id: number): AgentUsageToday | undefined {
  return current?.agents.find((a) => a.id === id);
}

export function projectUsageToday(name: string | undefined): ProjectUsageToday | undefined {
  if (!name) return undefined;
  return current?.projects.find((p) => p.name === name);
}

/** Every token counted once: uncached input, output, cache reads and writes. */
export function tokenTotal(models: readonly ModelTokenCounts[]): number {
  return models.reduce((n, m) => n + m.input + m.output + m.cacheRead + m.cacheWrite, 0);
}

export function sumModels(models: readonly ModelTokenCounts[]): Omit<ModelTokenCounts, 'model'> {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of models) {
    out.input += m.input;
    out.output += m.output;
    out.cacheRead += m.cacheRead;
    out.cacheWrite += m.cacheWrite;
  }
  return out;
}

/** 950, 12.3k, 4.5M, 1.2B: short enough for a panel row. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${unit}`;
    }
  }
  return String(n);
}
