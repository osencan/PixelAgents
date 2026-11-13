import { useEffect, useId, useRef, useState } from 'react';

import {
  AGENT_DETAIL_HISTORY_ROWS,
  AGENT_DETAIL_PANEL_WIDTH_PX,
  AGENT_DETAIL_RECENT_TOOLS,
  AGENT_ROLE_MAX_LENGTH,
  AGENT_ROLE_OPTIONS,
  PROJECT_LABEL_MAX_LENGTH,
} from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import {
  getActivityText,
  lifecycleAwareText,
  pendingApprovalTool,
  providerName,
} from '../office/agentActivity.js';
import { projectOfLabel } from '../office/agentFilter.js';
import type { AgentHistoryEntry } from '../office/agentHistory.js';
import { getAgentHistory } from '../office/agentHistory.js';
import { getAgentLifecycle, lifecycleText } from '../office/agentLifecycles.js';
import { getAgentRole, setAgentRole, useAgentRolesVersion } from '../office/agentRoles.js';
import { checkText } from '../office/checkResults.js';
import { getControlAccess, isApprovalOptedIn, useControlVersion } from '../office/controlAccess.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { setAgentHidden, useIsAgentHidden } from '../office/hiddenAgents.js';
import { getPendingPermission, usePermissionsVersion } from '../office/permissionRequests.js';
import { projectAccent } from '../office/projectPrefs.js';
import type { ToolActivity } from '../office/types.js';
import { transport } from '../transport/index.js';
import { PermissionButtons } from './PermissionButtons.js';
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
  /** Launched by the office (its terminal is in the drawer), not observed. */
  ownedByOffice?: boolean;
  /** Pin a project display name for every viewer; absent for read-only viewers. */
  onSetProjectLabel?: (agentId: number, label: string) => void;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Select value for a custom role (typed in a text field). */
const CUSTOM_ROLE = '__custom__';

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function historyText(e: AgentHistoryEntry): string {
  if (e.kind === 'tool_failed') return 'A tool failed';
  if (e.kind === 'check') return checkText(e.check ?? 'test', e.ok === true);
  return `${lifecycleText(e.lifecycle ?? 'unknown')}${e.observed ? '' : ' (guessed)'}`;
}

function nameOf(ch: { id: number; agentName?: string; directoryName?: string }): string {
  return ch.agentName || ch.directoryName || `Agent ${ch.id}`;
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
  onSetProjectLabel,
  ownedByOffice = false,
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

  // Agent control for this connection (approval opt-in switch, answers).
  useControlVersion();
  usePermissionsVersion();
  const pendingRequest = getPendingPermission(agentId);
  const controlAccess = getControlAccess();

  // The viewer's role badge for this agent (per browser).
  useAgentRolesVersion();
  const role = getAgentRole(agentId);
  const [editingRole, setEditingRole] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [customRole, setCustomRole] = useState('');
  useEffect(() => {
    setEditingRole(false);
    setRenamingProject(false);
  }, [agentId]);
  const roleChoice =
    editingRole || (role && !AGENT_ROLE_OPTIONS.includes(role)) ? CUSTOM_ROLE : (role ?? '');

  // When the current activity started (reset whenever its text changes).
  const since = useRef<{ id: number; text: string; at: number } | null>(null);

  // Jumping to a Parent/Linked agent swaps the panel's content; move focus to
  // the new heading so keyboard users don't fall back to the page start.
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingNext = useRef(false);
  useEffect(() => {
    if (!focusHeadingNext.current) return;
    focusHeadingNext.current = false;
    headingRef.current?.focus();
  }, [agentId]);
  const jumpTo = (id: number) => {
    focusHeadingNext.current = true;
    officeState.selectedAgentId = id;
  };

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
  const doing = lifecycleAwareText(activity, tools, life?.lifecycle);
  const approvalTool = pendingApprovalTool(tools, ch.bubbleType === 'permission');
  const needsApproval =
    ch.bubbleType === 'permission' || (tools?.some((t) => t.permissionWait && !t.done) ?? false);
  const recent = (tools ?? []).slice(-AGENT_DETAIL_RECENT_TOOLS).reverse();
  const subs = subagentCharacters.filter((s) => s.parentAgentId === agentId);
  // Real links only: a teammate's lead / a subagent's parent, and the agents
  // that name this one as theirs. Never inferred from a shared directory.
  const parentId = ch.leadAgentId ?? ch.parentAgentId ?? undefined;
  const parent = parentId !== undefined ? officeState.characters.get(parentId) : undefined;
  const linked = [...officeState.characters.values()].filter(
    (c) => c.leadAgentId === agentId && !c.isSubagent,
  );
  const history = getAgentHistory(agentId).slice(-AGENT_DETAIL_HISTORY_ROWS).reverse();
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
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start gap-8">
        {ch.directoryName && (
          <span
            aria-hidden="true"
            className="w-4 self-stretch shrink-0"
            style={{ background: projectAccent(ch.directoryName) }}
          />
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-normal leading-none overflow-hidden text-ellipsis whitespace-nowrap outline-none"
          >
            {ch.agentName || ch.directoryName || `Agent ${agentId}`}
          </h2>
          <span className="text-text-muted leading-none">
            {providerName(ch.directoryName)}
            {ch.isSubagent ? ' · subagent' : ''}
            {ch.isTeamLead ? ' · lead' : ''}
            {role ? ` · ${role}` : ''}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          <PixelIcon name="close" />
        </Button>
      </div>

      {/* Always mounted, so changes inside it (an approval request appearing)
          are announced; the rest of the panel re-renders every second and
          must not be live. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-10 empty:-mt-10">
        {hidden && (
          <div className="text-text-muted leading-tight" data-testid="agent-detail-hidden">
            Hidden from the office (this browser only). It keeps working; unhide to see it again.
          </div>
        )}

        {!needsApproval && life?.permissionSuspected && (
          <div className="text-text-muted leading-tight" data-testid="agent-detail-suspected">
            Maybe waiting for approval: a tool has run a while with no update. Guessed, not reported
            — a long command looks the same.
          </div>
        )}

        {needsApproval && (
          <div
            className="approval-glow p-8 flex flex-col gap-2"
            data-testid="agent-detail-approval"
          >
            <span className="font-bold">Needs your approval</span>
            <span className="break-words">
              {pendingRequest?.status ??
                (approvalTool ? approvalTool.status : 'Check the agent’s terminal')}
            </span>
            {pendingRequest && <PermissionButtons request={pendingRequest} now={now} />}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Row label="Doing">
          {officeState.isAsleep(agentId, now) ? 'Sleeping in the rest room' : doing}
        </Row>
        {life && (
          <Row label="State">
            {lifecycleText(life.lifecycle)}
            <span className="text-text-muted">{life.observed ? ' · reported' : ' · guessed'}</span>
          </Row>
        )}
        <Row label="For">{formatDuration(now - (life?.since ?? since.current.at))}</Row>
        {ch.directoryName && (
          <Row label="Project">
            {renamingProject && onSetProjectLabel ? (
              <input
                type="text"
                defaultValue={projectOfLabel(ch.directoryName)}
                maxLength={PROJECT_LABEL_MAX_LENGTH}
                autoFocus
                onBlur={(e) => {
                  setRenamingProject(false);
                  const value = e.currentTarget.value.trim();
                  if (value !== projectOfLabel(ch.directoryName)) onSetProjectLabel(agentId, value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRenamingProject(false);
                  }
                }}
                className="text-xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text w-160"
                aria-label="Project display name (all viewers; empty restores the folder name)"
              />
            ) : (
              <span className="flex flex-wrap items-center gap-4">
                {ch.directoryName}
                {onSetProjectLabel && !ch.isSubagent && (
                  <button
                    type="button"
                    className="underline cursor-pointer text-text-muted"
                    onClick={() => setRenamingProject(true)}
                    title="Pin a display name for this project (all viewers)"
                  >
                    rename
                  </button>
                )}
              </span>
            )}
          </Row>
        )}
        {ch.projectWorktree && <Row label="Worktree">{ch.projectWorktree}</Row>}
        {controlAccess.control && !ch.isSubagent && ch.directoryName && (
          <Row label="Approvals">
            <label className="flex items-center gap-4 cursor-pointer">
              <input
                type="checkbox"
                checked={isApprovalOptedIn(agentId)}
                onChange={(e) =>
                  transport.send({
                    type: 'setApprovalOptIn',
                    id: agentId,
                    enabled: e.target.checked,
                  })
                }
              />
              <span className="leading-tight">from the browser, for this project</span>
            </label>
          </Row>
        )}
        {controlAccess.control && !ch.isSubagent && !ownedByOffice && (
          <span className="text-text-muted leading-tight" data-testid="remote-control-hint">
            Started in your own terminal, so the office can't type into it. To send it messages from
            a browser or phone, start Claude with <code>claude --remote-control</code>.
          </span>
        )}
        {!ch.isSubagent && (
          <Row label="Role">
            <span className="flex flex-wrap items-center gap-4">
              <select
                className="text-xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text"
                value={roleChoice}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_ROLE) {
                    setCustomRole(role && !AGENT_ROLE_OPTIONS.includes(role) ? role : '');
                    setEditingRole(true);
                  } else {
                    setEditingRole(false);
                    setAgentRole(agentId, v);
                  }
                }}
                aria-label="Role badge (this browser)"
              >
                <option value="">none</option>
                {AGENT_ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
                <option value={CUSTOM_ROLE}>custom…</option>
              </select>
              {editingRole && (
                <input
                  type="text"
                  value={customRole}
                  maxLength={AGENT_ROLE_MAX_LENGTH}
                  autoFocus
                  onChange={(e) => setCustomRole(e.target.value)}
                  onBlur={() => {
                    setAgentRole(agentId, customRole);
                    setEditingRole(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="text-xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text w-100"
                  aria-label="Custom role"
                />
              )}
            </span>
          </Row>
        )}
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
                  <span aria-hidden="true">
                    {t.permissionWait && !t.done ? '!' : t.done ? '✓' : '…'}
                  </span>
                  <span className="sr-only">
                    {t.permissionWait && !t.done
                      ? 'Needs approval:'
                      : t.done
                        ? 'Done:'
                        : 'Running:'}
                  </span>
                </span>
                <span className={`min-w-0 break-words ${t.done ? 'text-text-muted' : ''}`}>
                  {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(parent || linked.length > 0) && (
        <div className="flex flex-col gap-4">
          {parent && (
            <Row label="Parent">
              <button
                type="button"
                className="underline cursor-pointer text-left"
                onClick={() => jumpTo(parent.id)}
              >
                {nameOf(parent)}
              </button>
            </Row>
          )}
          {linked.length > 0 && (
            <Row label="Linked">
              <span className="flex flex-col">
                {linked.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="underline cursor-pointer text-left"
                    onClick={() => jumpTo(c.id)}
                  >
                    {nameOf(c)}
                  </button>
                ))}
              </span>
            </Row>
          )}
        </div>
      )}

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

      {history.length > 0 && (
        <div className="flex flex-col gap-4">
          <span className="text-text-muted">Recent activity</span>
          <ul className="flex flex-col gap-2">
            {history.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-6 leading-tight">
                <span className="shrink-0 text-text-muted">{clock(e.at)}</span>
                <span className="min-w-0 break-words">
                  {historyText(e)}
                  {e.project && e.project !== ch.directoryName ? (
                    <span className="text-text-muted"> · {e.project}</span>
                  ) : null}
                </span>
              </li>
            ))}
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
