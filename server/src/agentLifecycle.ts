/**
 * One explicit lifecycle state per agent, derived from the state the provider
 * integrations already maintain, plus whether it was observed (a provider event
 * said so) or inferred (silence, timers, transcript heuristics).
 *
 * Rules that keep it honest:
 * - Only a permission event (hooks) means waiting_permission. The heuristic
 *   timer only sets `permissionSuspected`; the agent stays "running".
 * - A running tool stays running however long it takes.
 * - A turn with no tool and no data for STALE_AFTER_MS is "unknown", not sleep.
 */
import type { AgentLifecycleState } from '../../core/src/messages.js';
import { agentKey } from './agentMessages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { type HistoryByKey, readHistoryFile, writeHistoryFile } from './historyFile.js';
import type { ObservedCategory } from './sessionObservers/observer.js';
import { isObservedProvider } from './sessionObservers/observer.js';
import type { AgentState } from './types.js';

/** Silence (mid-turn, no tool running) after which the state is unknown. */
export const LIFECYCLE_STALE_AFTER_MS = 10 * 60_000;
/** How often silence is re-checked (event-driven otherwise). */
const LIFECYCLE_RECHECK_MS = 15_000;
/** Most recent history entries kept per agent. */
export const AGENT_HISTORY_MAX = 100;
/** History changes are written to disk at most this often. */
const HISTORY_SAVE_DELAY_MS = 5_000;

/**
 * One history entry: metadata only -- a state change or a failed tool, when,
 * and the project label at the time. Never prompts, commands, arguments or
 * output.
 */
export type AgentHistoryEntry =
  | {
      kind: 'state';
      lifecycle: AgentLifecycleState;
      observed: boolean;
      at: number;
      project?: string;
    }
  | { kind: 'tool_failed'; at: number; project?: string }
  | { kind: 'check'; check: 'test' | 'build'; ok: boolean; at: number; project?: string };

const READING_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
]);
const EDITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const RUNNING_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'Task', 'Agent']);

export interface LifecycleView {
  lifecycle: AgentLifecycleState;
  observed: boolean;
  permissionSuspected: boolean;
}

/** An observed session's category, as a lifecycle state. */
const OBSERVED_LIFECYCLE: Record<ObservedCategory, AgentLifecycleState> = {
  thinking: 'thinking',
  reading: 'reading',
  editing: 'editing',
  running: 'running',
  tool: 'working',
};

function toolCategory(agent: AgentState): AgentLifecycleState | undefined {
  // Background spawns stay in activeToolIds while their helper runs, across
  // the lead's turns; they are not what the lead itself is doing.
  const toolIds = [...agent.activeToolIds].filter((id) => !agent.backgroundSpawns.has(id));
  const latest = toolIds.at(-1);
  if (latest === undefined) return undefined;
  // Observed sessions send a compatibility tool name; the category is kept apart.
  if (isObservedProvider(agent.providerId))
    return OBSERVED_LIFECYCLE[agent.observedCategory ?? 'thinking'];
  const name = agent.activeToolNames.get(latest) ?? '';
  if (READING_TOOLS.has(name)) return 'reading';
  if (EDITING_TOOLS.has(name)) return 'editing';
  if (RUNNING_TOOLS.has(name)) return 'running';
  return 'working';
}

export function deriveLifecycle(
  agent: AgentState,
  now = Date.now(),
  /** Last provider event seen for the agent (hooks don't touch lastDataAt). */
  lastEventAt = 0,
): LifecycleView {
  // Hooks (Claude) and the session log observers report events; a transcript-only
  // Claude session is reconstructed from the transcript, so it is inferred.
  const observed = agent.hookDelivered === true;
  const suspected = agent.permissionSuspected === true;
  if (agent.permissionSent) {
    return { lifecycle: 'waiting_permission', observed: true, permissionSuspected: false };
  }
  if (!agent.turnActive) {
    return {
      lifecycle: agent.awaitingInput ? 'waiting_input' : 'idle',
      observed,
      permissionSuspected: false,
    };
  }
  // Claude in plan mode: reading/searching is part of planning.
  if (agent.planMode) return { lifecycle: 'planning', observed, permissionSuspected: suspected };
  const tool = toolCategory(agent);
  if (tool) return { lifecycle: tool, observed, permissionSuspected: suspected };
  if (now - Math.max(agent.lastDataAt, lastEventAt) > LIFECYCLE_STALE_AFTER_MS) {
    return { lifecycle: 'unknown', observed: false, permissionSuspected: false };
  }
  return { lifecycle: 'thinking', observed, permissionSuspected: suspected };
}

interface Tracked extends LifecycleView {
  since: number;
}

function lifecycleMessage(id: number, t: Tracked, replayed = false): Record<string, unknown> {
  return {
    type: 'agentLifecycle',
    id,
    lifecycle: t.lifecycle,
    observed: t.observed,
    permissionSuspected: t.permissionSuspected || undefined,
    since: t.since,
    // A reconnect replay: the state is current, but nothing just happened.
    replayed: replayed || undefined,
  };
}

export interface AgentLifecycleService {
  /** Current states and recent history, for a (re)connecting client. */
  snapshot(send: (message: Record<string, unknown>) => void): void;
  /** Forget all history, in memory and on disk; tell every client. */
  clearHistory(): void;
  dispose(): void;
}

export interface AgentLifecycleOptions {
  /** Keep the last day of history in this file across restarts (standalone server). */
  historyFile?: string;
}

// The running service per store, so the reconnect path can replay states.
const services = new WeakMap<AgentStateStore, AgentLifecycleService>();

/** Forget all agents' history (the clearHistory message). */
export function clearAllHistory(store: AgentStateStore): void {
  services.get(store)?.clearHistory();
}

/** Replay current lifecycle states to one (re)connecting client. */
export function sendLifecycleSnapshot(
  store: AgentStateStore,
  send: (message: Record<string, unknown>) => void,
): void {
  services.get(store)?.snapshot(send);
}

export function startAgentLifecycle(
  store: AgentStateStore,
  options: AgentLifecycleOptions = {},
): AgentLifecycleService {
  const tracked = new Map<number, Tracked>();
  const scheduled = new Set<number>();
  // Last time any message about the agent went out (a provider event happened).
  const lastEventAt = new Map<number, number>();
  const history = new Map<number, AgentHistoryEntry[]>();
  // On disk, by agentKey: ids are reassigned on restart, session keys are not.
  const { historyFile } = options;
  const saved: HistoryByKey = historyFile ? readHistoryFile(historyFile) : new Map();
  // Last known key per id: a removed agent is already gone from the store.
  const keyById = new Map<number, string>();
  const keyOf = (id: number) => {
    const agent = store.get(id);
    if (agent) keyById.set(id, agentKey(agent));
    return keyById.get(id);
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!historyFile) return;
    for (const [id, list] of history) {
      const key = keyOf(id);
      if (key) saved.set(key, list);
    }
    writeHistoryFile(historyFile, saved);
  };
  const persist = () => {
    if (!historyFile || saveTimer) return;
    saveTimer = setTimeout(saveNow, HISTORY_SAVE_DELAY_MS);
    saveTimer.unref?.();
  };
  /** An agent (re)appeared: pick up its saved history, if any. */
  const restore = (id: number) => {
    if (history.has(id)) return;
    const key = keyOf(id);
    const prior = key ? saved.get(key) : undefined;
    if (prior?.length) history.set(id, prior.slice(-AGENT_HISTORY_MAX));
  };
  const record = (id: number, entry: AgentHistoryEntry) => {
    const list = history.get(id) ?? [];
    list.push(entry);
    if (list.length > AGENT_HISTORY_MAX) list.splice(0, list.length - AGENT_HISTORY_MAX);
    history.set(id, list);
    persist();
  };

  const evaluate = (id: number) => {
    const agent = store.get(id);
    if (!agent) {
      tracked.delete(id);
      return;
    }
    const view = deriveLifecycle(agent, Date.now(), lastEventAt.get(id));
    const prev = tracked.get(id);
    if (
      prev &&
      prev.lifecycle === view.lifecycle &&
      prev.observed === view.observed &&
      prev.permissionSuspected === view.permissionSuspected
    ) {
      return;
    }
    const next = { ...view, since: prev?.lifecycle === view.lifecycle ? prev.since : Date.now() };
    tracked.set(id, next);
    if (prev?.lifecycle !== next.lifecycle) {
      record(id, {
        kind: 'state',
        lifecycle: next.lifecycle,
        observed: next.observed,
        at: next.since,
        project: agent.directoryName,
      });
    }
    store.broadcast(lifecycleMessage(id, next));
  };

  // Integrations mutate state, then broadcast, often several messages in a
  // row: evaluate once after the synchronous batch settles.
  const schedule = (id: number) => {
    if (scheduled.has(id)) return;
    scheduled.add(id);
    queueMicrotask(() => {
      scheduled.delete(id);
      evaluate(id);
    });
  };

  const onBroadcast = (message: Record<string, unknown>) => {
    if (message.type === 'agentLifecycle' || typeof message.id !== 'number') return;
    // Only agents in the store have a lifecycle (and a history to clean up).
    if (!store.has(message.id)) return;
    lastEventAt.set(message.id, Date.now());
    if (message.type === 'agentCheckResult') {
      record(message.id, {
        kind: 'check',
        check: message.check === 'build' ? 'build' : 'test',
        ok: message.ok === true,
        at: typeof message.at === 'number' ? message.at : Date.now(),
        project: store.get(message.id)?.directoryName,
      });
    }
    if (message.type === 'agentToolFailed') {
      record(message.id, {
        kind: 'tool_failed',
        at: typeof message.at === 'number' ? message.at : Date.now(),
        project: store.get(message.id)?.directoryName,
      });
    }
    schedule(message.id);
  };
  const onAdded = (id: number) => {
    restore(id);
    schedule(id);
  };
  const onRemoved = (id: number) => {
    // Its saved copy stays (keyed by session) until it ages out.
    const key = keyOf(id);
    const list = history.get(id);
    if (key && list) saved.set(key, list);
    keyById.delete(id);
    tracked.delete(id);
    history.delete(id);
    lastEventAt.delete(id);
  };

  store.on('broadcast', onBroadcast);
  store.on('agentAdded', onAdded);
  store.on('agentRemoved', onRemoved);
  const timer = setInterval(() => {
    for (const [id] of store) evaluate(id);
  }, LIFECYCLE_RECHECK_MS);
  timer.unref();
  for (const [id] of store) {
    restore(id);
    schedule(id);
  }

  const service: AgentLifecycleService = {
    snapshot(send) {
      for (const [id] of store) {
        if (!tracked.has(id)) evaluate(id);
        const t = tracked.get(id);
        if (t) send(lifecycleMessage(id, t, true));
        const entries = history.get(id);
        if (entries?.length) send({ type: 'agentHistory', id, entries });
      }
    },
    clearHistory() {
      history.clear();
      saved.clear();
      saveNow();
      for (const [id] of store) store.broadcast({ type: 'agentHistory', id, entries: [] });
    },
    dispose() {
      if (saveTimer) saveNow();
      clearInterval(timer);
      store.off('broadcast', onBroadcast);
      store.off('agentAdded', onAdded);
      store.off('agentRemoved', onRemoved);
      services.delete(store);
    },
  };
  services.set(store, service);
  return service;
}
