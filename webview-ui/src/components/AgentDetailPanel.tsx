import { useEffect, useRef, useState } from 'react';

import { AGENT_DETAIL_PANEL_WIDTH_PX, AGENT_DETAIL_RECENT_TOOLS } from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import { getActivityText, pendingApprovalTool, providerName } from '../office/agentActivity.js';
import { getAgentLifecycle, lifecycleText } from '../office/agentLifecycles.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { setAgentHidden, useIsAgentHidden } from '../office/hiddenAgents.js';
import type { ToolActivity } from '../office/types.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface AgentDetailPanelProps {
  agentId: number;
  officeState: OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  /** Phone: overlay the office's bottom instead of docking beside it. */
  mobile: boolean;
  /** Close the panel only (deselects the character). */
  onClose: () => void;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-8 leading-tight">
      <span className="text-text-muted shrink-0 w-72">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * What the selected agent is doing right now, docked beside the office. Its ×
 * only closes the panel; hiding takes the character out of the office view
 * without removing the session, and the same panel unhides it.
 * Read-only viewers receive tool activity as categories (server-side), so the
 * same panel shows them less detail.
 */
export function AgentDetailPanel({
  agentId,
  officeState,
  agentTools,
  subagentTools,
  subagentCharacters,
  mobile,
  onClose,
}: AgentDetailPanelProps) {
  // Character state is imperative (the game loop mutates it): poll it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Hiding is this viewer's choice only: the agent keeps working and its card
  // stays in the stack, faded, until unhidden here.
  const hidden = useIsAgentHidden(agentId);

  // When the current activity started (reset whenever its text changes).
  const since = useRef<{ id: number; text: string; at: number } | null>(null);

  const ch = officeState.characters.get(agentId);
  if (!ch) return null;

  const tools = agentTools[agentId];
  const activity = getActivityText(
    agentId,
    agentTools,
    ch.isActive,
    ch.bubbleType,
    ch.waitingAwaitingInput ?? false,
  );
  if (!since.current || since.current.id !== agentId || since.current.text !== activity) {
    since.current = { id: agentId, text: activity, at: now };
  }
  const life = getAgentLifecycle(agentId);
  const approvalTool = pendingApprovalTool(tools, ch.bubbleType === 'permission');
  const needsApproval =
    ch.bubbleType === 'permission' || (tools?.some((t) => t.permissionWait && !t.done) ?? false);
  const recent = (tools ?? []).slice(-AGENT_DETAIL_RECENT_TOOLS).reverse();
  const subs = subagentCharacters.filter((s) => s.parentAgentId === agentId);
  const contextPct =
    ch.contextReported && ch.maxContextTokens > 0
      ? Math.round((ch.contextTokens / ch.maxContextTokens) * 100)
      : null;

  return (
    <aside
      className={`pixel-panel flex flex-col gap-10 p-12 text-sm overflow-y-auto z-20 ${
        mobile
          ? 'absolute left-8 right-8 bottom-8 max-h-[45%]'
          : 'h-full shrink-0 border-l-2 border-border'
      }`}
      style={mobile ? undefined : { width: AGENT_DETAIL_PANEL_WIDTH_PX }}
      data-testid="agent-detail-panel"
      aria-label="Agent details"
    >
      <div className="flex items-start gap-8">
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-lg leading-none overflow-hidden text-ellipsis whitespace-nowrap">
            {ch.agentName || ch.directoryName || `Agent ${agentId}`}
          </span>
          <span className="text-text-muted leading-none">
            {providerName(ch.directoryName)}
            {ch.isSubagent ? ' · subagent' : ''}
            {ch.isTeamLead ? ' · lead' : ''}
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close panel">
          <PixelIcon name="close" />
        </Button>
      </div>

      {hidden && (
        <div className="text-text-muted leading-tight" data-testid="agent-detail-hidden">
          Hidden from the office (this browser only). It keeps working; unhide to see it again.
        </div>
      )}

      {!needsApproval && life?.permissionSuspected && (
        <div className="text-text-muted leading-tight" data-testid="agent-detail-suspected">
          Maybe waiting for approval: a tool has run a while with no update. Guessed, not reported —
          a long command looks the same.
        </div>
      )}

      {needsApproval && (
        <div className="approval-glow p-8 flex flex-col gap-2" data-testid="agent-detail-approval">
          <span className="font-bold">Needs your approval</span>
          <span className="break-words">
            {approvalTool ? approvalTool.status : 'Check the agent’s terminal'}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Row label="Doing">{activity}</Row>
        {life && (
          <Row label="State">
            {lifecycleText(life.lifecycle)}
            <span className="text-text-muted">{life.observed ? ' · reported' : ' · guessed'}</span>
          </Row>
        )}
        <Row label="For">{formatDuration(now - (life?.since ?? since.current.at))}</Row>
        {ch.directoryName && <Row label="Project">{ch.directoryName}</Row>}
        {contextPct !== null && <Row label="Context">{contextPct}% used</Row>}
      </div>

      <div className="flex flex-col gap-4">
        <span className="text-text-muted">This turn</span>
        {recent.length === 0 ? (
          <span className="text-text-muted">No tool activity yet</span>
        ) : (
          <ul className="flex flex-col gap-2">
            {recent.map((t) => (
              <li key={t.toolId} className="flex gap-6 leading-tight">
                <span className="shrink-0 w-12">
                  {t.permissionWait && !t.done ? '!' : t.done ? '✓' : '…'}
                </span>
                <span className={`min-w-0 break-words ${t.done ? 'text-text-muted' : ''}`}>
                  {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {subs.length > 0 && (
        <div className="flex flex-col gap-4">
          <span className="text-text-muted">Subagents</span>
          <ul className="flex flex-col gap-2">
            {subs.map((s) => {
              const rows = subagentTools[s.parentAgentId]?.[s.parentToolId];
              const current = rows ? [...rows].reverse().find((t) => !t.done) : undefined;
              return (
                <li key={s.id} className="leading-tight break-words">
                  {s.label || 'Subtask'}
                  {current ? <span className="text-text-muted"> — {current.status}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!ch.isSubagent && (
        <div className="mt-auto pt-8 flex gap-6 items-center">
          {hidden ? (
            <Button size="sm" onClick={() => setAgentHidden(agentId, false)}>
              Unhide
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setAgentHidden(agentId, true)}>
              Hide from office
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
