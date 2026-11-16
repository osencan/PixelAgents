import { useEffect } from 'react';

import { getAgentLifecycle } from '../office/agentLifecycles.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { quietState } from '../office/stuckAgents.js';
import { isEditableTarget, triageOrder, type TriageRank, TriageStepper } from '../office/triage.js';

const ACTIVE = new Set(['thinking', 'planning', 'reading', 'editing', 'running', 'working']);

/** Alt+Down / Alt+Up select the next / previous agent by urgency (office/triage.ts). */
export function useTriageKeys(getOfficeState: () => OfficeState): void {
  useEffect(() => {
    const stepper = new TriageStepper();
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      const os = getOfficeState();
      const now = Date.now();
      const rank = (id: number): TriageRank => {
        const ch = os.characters.get(id);
        const life = getAgentLifecycle(id);
        if (ch?.bubbleType === 'permission' || life?.lifecycle === 'waiting_permission') return 0;
        if (quietState(id, life, now)) return 1;
        if (life && ACTIVE.has(life.lifecycle)) return 2;
        return 3;
      };
      const compute = () =>
        triageOrder(
          [...os.characters.values()]
            .filter((c) => !c.isSubagent && !os.isHidden(c.id))
            .map((c) => c.id),
          rank,
        );
      const next = stepper.step(e.key === 'ArrowDown' ? 1 : -1, os.selectedAgentId, compute, now);
      if (next !== undefined) os.selectAndFollow(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [getOfficeState]);
}
