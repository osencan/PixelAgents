/**
 * Read-only session observers: CLIs the office shows by watching their own
 * session logs (Codex, Gemini CLI, Grok Build, Antigravity). An observer never starts,
 * stops, resumes or sends anything to its CLI, never writes to its folders,
 * and keeps only metadata: ids, cwd, turn phase and the kind of tool in use,
 * never prompts, arguments or results.
 */

/** What an observed session is doing, as far as its log tells. */
export type ObservedCategory = 'thinking' | 'reading' | 'editing' | 'running' | 'tool';

export interface ObservedSession {
  id: string;
  cwd: string;
  /** Parent session id, when the log names one (Codex). */
  parent?: string;
  /** A subagent whose parent the log doesn't name (Gemini). */
  subagent?: boolean;
  phase: 'active' | 'idle';
  category: ObservedCategory;
  /** A turn started or ended at least once: the log is a real session. */
  seenTurn: boolean;
  /** Time of the newest event, ms. */
  updated: number;
}

export function emptyObservedSession(): ObservedSession {
  return { id: '', cwd: '', phase: 'idle', category: 'thinking', seenTurn: false, updated: 0 };
}

/** Each observed provider's name, as its labels and status text show it. */
export const OBSERVED_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  antigravity: 'Antigravity',
};

export function isObservedProvider(providerId: string | undefined): boolean {
  return providerId !== undefined && Object.hasOwn(OBSERVED_PROVIDER_NAMES, providerId);
}

const CATEGORY_TEXT: Record<ObservedCategory, string> = {
  thinking: 'working',
  reading: 'reading / searching',
  editing: 'editing',
  running: 'running a command',
  tool: 'using a tool',
};

/** The status text an observed agent shows, e.g. "Gemini: editing". */
export function observedStatus(displayName: string, category: ObservedCategory): string {
  return `${displayName}: ${CATEGORY_TEXT[category]}`;
}

/** Follows one session file. `read` picks up whatever changed since the last call. */
export interface SessionReader {
  readonly session: ObservedSession;
  read(file: string): Promise<void>;
}

export interface SessionObserver {
  providerId: string;
  displayName: string;
  /** Environment variable that turns this observer off when set to `0`. */
  disableEnv: string;
  /** An active turn whose log is silent this long shows as waiting (off when unset). */
  staleActiveMs?: number;
  /** Every session file worth following; missing folders give none. */
  listFiles(): Promise<string[]>;
  createReader(file: string): SessionReader;
}
