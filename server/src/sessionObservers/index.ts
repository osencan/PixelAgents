import * as fs from 'node:fs/promises';

import type { AgentStateStore } from '../agentStateStore.js';
import { antigravityObserver } from './antigravity.js';
import { codexObserver } from './codex.js';
import { geminiObserver } from './gemini.js';
import { grokObserver } from './grok.js';
import type { SessionObserver, SessionReader } from './observer.js';
import { OBSERVER_RECENT_MS, ObserverOfficeBridge } from './officeBridge.js';

export const SESSION_OBSERVERS: readonly SessionObserver[] = [
  codexObserver,
  geminiObserver,
  grokObserver,
  antigravityObserver,
];

/** How often followed files are read. */
const POLL_MS = 1000;
/** How often the session folders are listed again. */
const RESCAN_MS = 5000;

/** Follows one observer's session files and keeps its characters in the office. */
function startObserver(store: AgentStateStore, observer: SessionObserver): { dispose(): void } {
  const bridge = new ObserverOfficeBridge(
    store,
    observer.providerId,
    observer.displayName,
    observer.staleActiveMs,
  );
  const readers = new Map<string, SessionReader>();
  const baseline = new Map<string, number>();
  let stopped = false,
    polling = false,
    nextScan = 0;
  let files: string[] = [];
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (Date.now() >= nextScan) {
        files = await observer.listFiles();
        nextScan = Date.now() + RESCAN_MS;
        const present = new Set(files);
        for (const [file, reader] of readers)
          if (!present.has(file)) {
            bridge.remove(reader.session.id);
            readers.delete(file);
            baseline.delete(file);
          }
      }
      for (const file of files) {
        if (stopped) break;
        try {
          const stat = await fs.stat(file);
          let reader = readers.get(file);
          const previous = baseline.get(file);
          baseline.set(file, stat.size);
          if (!reader) {
            if (
              Date.now() - stat.mtimeMs > OBSERVER_RECENT_MS &&
              (previous === undefined || previous === stat.size)
            )
              continue;
            reader = observer.createReader(file);
            readers.set(file, reader);
          }
          await reader.read(file);
          if (!stopped) bridge.sync(reader.session);
        } catch {
          /* One disappearing or unreadable log must not break other sessions. */
        }
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), POLL_MS);
  timer.unref();
  void poll();
  return {
    dispose() {
      stopped = true;
      clearInterval(timer);
      bridge.dispose();
    },
  };
}

/** Independent observers; they never start, stop, resume or send commands to their CLIs. */
export function startSessionObservers(
  store: AgentStateStore,
  observers: readonly SessionObserver[] = SESSION_OBSERVERS,
): { dispose(): void } {
  const running = observers
    .filter((o) => process.env[o.disableEnv] !== '0')
    .map((o) => {
      console.log(`[Pixel Agents] ${o.displayName} read-only session detection enabled`);
      return startObserver(store, o);
    });
  return {
    dispose() {
      for (const r of running) r.dispose();
    },
  };
}
