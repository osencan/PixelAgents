import * as path from 'node:path';

import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import type { ObservedSession } from './observer.js';
import { observedStatus } from './observer.js';

/** A session last written longer ago than this is not brought into the office. */
export const OBSERVER_RECENT_MS = 5 * 60_000;
/** A tracked session silent for this long leaves the office. */
const EXPIRE_MS = 30 * 60_000;

/** Turns one provider's observed sessions into office characters. */
export class ObserverOfficeBridge {
  private tracked = new Map<string, { id: number; signature: string }>();
  constructor(
    private store: AgentStateStore,
    private providerId: string,
    private displayName: string,
    private staleActiveMs?: number,
  ) {}
  sync(s: ObservedSession, now = Date.now()): void {
    if (!s.id || !s.cwd || !s.seenTurn) return;
    let entry = this.tracked.get(s.id);
    if (now - s.updated > EXPIRE_MS) {
      this.remove(s.id);
      return;
    }
    // Do not fill the office with historical sessions on startup.
    if (!entry && now - s.updated > OBSERVER_RECENT_MS) return;
    if (entry && !this.store.has(entry.id)) {
      this.tracked.delete(s.id);
      entry = undefined;
    }
    if (!entry) {
      const id = this.store.nextAgentId.current++;
      const sub = s.parent !== undefined || s.subagent === true;
      const agent = createAgentState({
        id,
        sessionId: `${this.providerId}:${s.id}`,
        projectDir: s.cwd,
        jsonlFile: '',
        isExternal: true,
        hooksOnly: true,
        hookDelivered: true,
        providerId: this.providerId,
        directoryName: `${this.displayName} · ${path.basename(s.cwd) || s.cwd}${sub ? ' · subagent' : ''}`,
        lastDataAt: s.updated,
      });
      agent.projectCwd = s.cwd;
      // A subagent whose parent session is in the office is linked to it (a
      // real parent id from the log, never inferred from a shared cwd):
      // it takes the teammate path -- parent's look, a desk near it, a badge.
      const parent = s.parent ? this.tracked.get(s.parent) : undefined;
      const parentAgent = parent ? this.store.get(parent.id) : undefined;
      if (parentAgent) {
        agent.leadAgentId = parentAgent.id;
        agent.agentName = 'subagent';
        agent.palette = parentAgent.palette;
        agent.repeat = parentAgent.repeat;
      }
      assignPaletteIfNeeded(agent, this.store);
      this.store.set(id, agent);
      entry = { id, signature: '' };
      this.tracked.set(s.id, entry);
    }
    const agent = this.store.get(entry.id)!;
    agent.lastDataAt = s.updated;
    // The label refresher (claudeDirectoryLabels) follows later cwd changes.
    agent.projectCwd = s.cwd;
    const stale = this.staleActiveMs !== undefined && now - s.updated > this.staleActiveMs;
    const phase = stale ? 'idle' : s.phase;
    const signature = JSON.stringify([phase, s.category]);
    if (signature === entry.signature) return;
    entry.signature = signature;
    agent.activeToolIds.clear();
    agent.activeToolNames.clear();
    agent.activeToolStatuses.clear();
    agent.turnActive = phase === 'active';
    agent.isWaiting = !agent.turnActive;
    agent.observedCategory = agent.turnActive ? s.category : undefined;
    this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
    if (agent.turnActive) {
      const toolId = `${this.providerId}-activity-${agent.id}`;
      const status = observedStatus(this.displayName, s.category);
      // Existing renderer taxonomy: Read gets the reading animation; Edit gets typing.
      const toolName = s.category === 'reading' ? 'Read' : 'Edit';
      agent.activeToolIds.add(toolId);
      agent.activeToolNames.set(toolId, toolName);
      agent.activeToolStatuses.set(toolId, status);
      this.store.broadcast({ type: 'agentToolStart', id: agent.id, toolId, toolName, status });
    }
    this.store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status: agent.turnActive ? 'active' : 'waiting',
      awaitingInput: false,
    });
  }
  remove(sessionId: string): void {
    const entry = this.tracked.get(sessionId);
    if (entry) this.store.delete(entry.id);
    this.tracked.delete(sessionId);
  }
  dispose(): void {
    for (const id of this.tracked.keys()) this.remove(id);
  }
}
