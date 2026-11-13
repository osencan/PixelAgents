/**
 * This viewer's project/provider filter: which agents the office shows. Like
 * hiding, it changes visibility only (per browser, persisted): filtered agents
 * keep running, keep their seats and state, and leave the card stack until the
 * filter lets them back. It never stops or alters a session.
 */
import { useSyncExternalStore } from 'react';

import { AGENT_FILTER_STORAGE_KEY } from '../constants.js';
import { providerName } from './agentActivity.js';

const CODEX_PREFIX = 'Codex · ';
const SUBAGENT_SUFFIX = ' · subagent';

interface Stored {
  providers: string[];
  projects: string[];
}

let excludedProviders = new Set<string>();
let excludedProjects = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

(function load() {
  try {
    const raw = JSON.parse(
      localStorage.getItem(AGENT_FILTER_STORAGE_KEY) ?? '{}',
    ) as Partial<Stored>;
    if (Array.isArray(raw.providers)) excludedProviders = new Set(raw.providers);
    if (Array.isArray(raw.projects)) excludedProjects = new Set(raw.projects);
  } catch {
    /* storage unavailable or corrupt: show everything */
  }
})();

function changed(): void {
  version += 1;
  try {
    const stored: Stored = { providers: [...excludedProviders], projects: [...excludedProjects] };
    localStorage.setItem(AGENT_FILTER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable (private window): the filter lasts for this page only.
  }
  for (const l of listeners) l();
}

/** The project part of a character label ("Codex · site · subagent" -> "site"). */
export function projectOfLabel(directoryName: string | undefined): string {
  let name = directoryName ?? '';
  if (name.startsWith(CODEX_PREFIX)) name = name.slice(CODEX_PREFIX.length);
  if (name.endsWith(SUBAGENT_SUFFIX)) name = name.slice(0, -SUBAGENT_SUFFIX.length);
  return name || 'Unknown project';
}

/** True when this viewer's filter leaves out an agent with this label. */
export function isFilteredOut(directoryName: string | undefined): boolean {
  return (
    excludedProviders.has(providerName(directoryName)) ||
    excludedProjects.has(projectOfLabel(directoryName))
  );
}

export function isProviderShown(provider: string): boolean {
  return !excludedProviders.has(provider);
}

export function isProjectShown(project: string): boolean {
  return !excludedProjects.has(project);
}

export function toggleProvider(provider: string): void {
  excludedProviders = new Set(excludedProviders);
  if (!excludedProviders.delete(provider)) excludedProviders.add(provider);
  changed();
}

export function toggleProject(project: string): void {
  excludedProjects = new Set(excludedProjects);
  if (!excludedProjects.delete(project)) excludedProjects.add(project);
  changed();
}

export function clearFilter(): void {
  excludedProviders = new Set();
  excludedProjects = new Set();
  changed();
}

export function isFilterActive(): boolean {
  return excludedProviders.size > 0 || excludedProjects.size > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render on any filter change (React side). */
export function useAgentFilterVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
