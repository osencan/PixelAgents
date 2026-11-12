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
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/** Silence (mid-turn, no tool running) after which the state is unknown. */
export const LIFECYCLE_STALE_AFTER_MS = 10 * 60_000;
/** How often silence is re-checked (event-driven otherwise). */
const LIFECYCLE_RECHECK_MS = 15_000;

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

/** Codex sends a compatibility tool name; its status text carries the category. */
function codexCategory(status: string): AgentLifecycleState {
  if (/reading|searching/i.test(status)) return 'reading';
  if (/editing/i.test(status)) return 'editing';
  if (/running a command/i.test(status)) return 'running';
  if (/using a tool/i.test(status)) return 'working';
  return 'thinking';
}

function toolCategory(agent: AgentState): AgentLifecycleState | undefined {
  const toolIds = [...agent.activeToolIds];
  const latest = toolIds.at(-1);
  if (latest === undefined) return undefined;
  if (agent.providerId === 'codex')
    return codexCategory(agent.activeToolStatuses.get(latest) ?? '');
  const name = agent.activeToolNames.get(latest) ?? '';
  if (READING_TOOLS.has(name)) return 'reading';
  if (EDITING_TOOLS.has(name)) return 'editing';
  if (RUNNING_TOOLS.has(name)) return 'running';
  return 'working';
}

export function deriveLifecycle(agent: AgentState, now = Date.now()): LifecycleView {
  // Hooks (Claude) and the Codex log observer report events; a transcript-only
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
  const tool = toolCategory(agent);
  if (tool) return { lifecycle: tool, observed, permissionSuspected: suspected };
  if (now - agent.lastDataAt > LIFECYCLE_STALE_AFTER_MS) {
    return { lifecycle: 'unknown', observed: false, permissionSuspected: false };
  }
  return { lifecycle: 'thinking', observed, permissionSuspected: suspected };
}

interface Tracked extends LifecycleView {
  since: number;
}

function lifecycleMessage(id: number, t: Tracked): Record<string, unknown> {
  return {
    type: 'agentLifecycle',
    id,
    lifecycle: t.lifecycle,
    observed: t.observed,
    permissionSuspected: t.permissionSuspected || undefined,
    since: t.since,
  };
}

export interface AgentLifecycleService {
  /** Current states, for a (re)connecting client. */
  snapshot(send: (message: Record<string, unknown>) => void): void;
  dispose(): void;
}

// The running service per store, so the reconnect path can replay states.
const services = new WeakMap<AgentStateStore, AgentLifecycleService>();

/** Replay current lifecycle states to one (re)connecting client. */
export function sendLifecycleSnapshot(
  store: AgentStateStore,
  send: (message: Record<string, unknown>) => void,
): void {
  services.get(store)?.snapshot(send);
}

export function startAgentLifecycle(store: AgentStateStore): AgentLifecycleService {
  const tracked = new Map<number, Tracked>();
  const scheduled = new Set<number>();

  const evaluate = (id: number) => {
    const agent = store.get(id);
    if (!agent) {
      tracked.delete(id);
      return;
    }
    const view = deriveLifecycle(agent);
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
    schedule(message.id);
  };
  const onAdded = (id: number) => schedule(id);
  const onRemoved = (id: number) => tracked.delete(id);

  store.on('broadcast', onBroadcast);
  store.on('agentAdded', onAdded);
  store.on('agentRemoved', onRemoved);
  const timer = setInterval(() => {
    for (const [id] of store) evaluate(id);
  }, LIFECYCLE_RECHECK_MS);
  timer.unref();
  for (const [id] of store) schedule(id);

  const service: AgentLifecycleService = {
    snapshot(send) {
      for (const [id] of store) {
        if (!tracked.has(id)) evaluate(id);
        const t = tracked.get(id);
        if (t) send(lifecycleMessage(id, t));
      }
    },
    dispose() {
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
