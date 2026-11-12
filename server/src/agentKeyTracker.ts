/**
 * Announces when an agent's stable key changes while it stays the same
 * character: `/clear` (and a resumed transcript) continue in the same terminal
 * under a new session id. Viewers move their per-browser preferences (hidden,
 * role) from the old key to the new one instead of losing them.
 */
import { agentKey } from './agentMessages.js';
import type { AgentStateStore } from './agentStateStore.js';

export function startAgentKeyTracker(store: AgentStateStore): { dispose(): void } {
  const keys = new Map<number, string>();
  const scheduled = new Set<number>();

  const check = (id: number) => {
    const agent = store.get(id);
    if (!agent) {
      keys.delete(id);
      return;
    }
    const key = agentKey(agent);
    const previous = keys.get(id);
    keys.set(id, key);
    if (previous !== undefined && previous !== key) {
      store.broadcast({ type: 'agentKeyChanged', id, agentKey: key, previousKey: previous });
    }
  };
  // Reassignments mutate the agent, then broadcast (activity clear, status):
  // check once after that synchronous batch.
  const schedule = (id: number) => {
    if (scheduled.has(id)) return;
    scheduled.add(id);
    queueMicrotask(() => {
      scheduled.delete(id);
      check(id);
    });
  };

  const onBroadcast = (message: Record<string, unknown>) => {
    if (message.type === 'agentKeyChanged' || typeof message.id !== 'number') return;
    schedule(message.id);
  };
  const onAdded = (id: number) => check(id);
  const onRemoved = (id: number) => keys.delete(id);
  store.on('broadcast', onBroadcast);
  store.on('agentAdded', onAdded);
  store.on('agentRemoved', onRemoved);
  for (const [id] of store) check(id);

  return {
    dispose() {
      store.off('broadcast', onBroadcast);
      store.off('agentAdded', onAdded);
      store.off('agentRemoved', onRemoved);
    },
  };
}
