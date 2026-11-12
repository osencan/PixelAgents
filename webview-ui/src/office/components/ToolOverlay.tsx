import { Fragment, useEffect, useRef, useState } from 'react';

import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_GAUGE_GAP_PX,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_GAP_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';

/** Side of the '!' beacon shown when no permission bubble sprite is up (CSS px). */
const APPROVAL_BEACON_SIZE_PX = 18;
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import {
  getActivityText,
  NEEDS_APPROVAL_TEXT,
  WAITING_INPUT_ACTIVITY_TEXT,
} from '../agentActivity.js';
import { ContextBar } from '../ContextBar.js';
import { contextLeft } from '../contextGauge.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  alwaysShowOverlay: boolean;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  // Hovering a sub-agent swaps its lead's label for its own (they'd overlap).
  const hoveredSubParentId =
    hoveredId !== null
      ? subagentCharacters.find((s) => s.id === hoveredId)?.parentAgentId
      : undefined;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch || officeState.isHidden(id)) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble.
        const needsApproval =
          ch.bubbleType === 'permission' ||
          (agentTools[id]?.some((t) => t.permissionWait && !t.done) ?? false);
        let bubbleNode = null;
        // Screen y of the bubble's top edge, when one shows: the label stacks above it.
        let bubbleTop: number | null = null;
        if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
          const cachedBubble = getCachedSprite(
            ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
            zoom,
          );
          const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          const alpha =
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1;
          bubbleTop =
            project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
            (cachedBubble.height + zoom) / dpr;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top: bubbleTop,
                opacity: alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <div className={needsApproval ? 'approval-beacon' : undefined}>
                <OverlayBubble cached={cachedBubble} dpr={dpr} />
              </div>
            </div>
          );
        } else if (needsApproval) {
          // Approval flagged on a tool without a bubble: a beacon over the head.
          const beaconSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          bubbleTop =
            project.toScreenY(ch.y + beaconSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
            APPROVAL_BEACON_SIZE_PX;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none approval-beacon flex items-center justify-center font-bold text-black"
              style={{
                left: project.toScreenX(ch.x),
                top: bubbleTop,
                width: APPROVAL_BEACON_SIZE_PX,
                height: APPROVAL_BEACON_SIZE_PX,
                background: 'var(--color-status-permission)',
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
              data-testid="approval-beacon"
            >
              !
            </div>
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on) — the bubble renders regardless.
        if (!alwaysShowOverlay && !isSelected && !isHovered) {
          return bubbleNode && <Fragment key={id}>{bubbleNode}</Fragment>;
        }

        // Position above character: the sprite's top edge (the tallest hair
        // reaches it), or the bubble's when one shows over the head.
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);
        const labelBottom = Math.min(screenY, bubbleTop ?? screenY) - TOOL_OVERLAY_GAP_PX;

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        // Likewise for a label that gives way: a sub-agent's shows only while
        // hovered or selected, even with always-show on (the lead's label
        // already names the subtask), and a hovered sub-agent's lead hides
        // its own so the sub's isn't covered.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        const givesWay = (isSub && !isSelected && !isHovered) || id === hoveredSubParentId;
        if ((isDone && !alwaysShowOverlay && !isSelected && !isHovered) || givesWay) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = NEEDS_APPROVAL_TEXT;
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as the server reports its context (a cleared
        // session's 0 included: a full gauge). Sub-agents never do: they have
        // no session of their own, so nothing is ever reported for them.
        // Drawn as a health bar: full when the context is empty, draining as
        // it fills (the colour still warns by the share used).
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextReported === true;

        return (
          <Fragment key={id}>
            {bubbleNode}
            <div
              // The label grows upward from labelBottom, so extra lines and the
              // context gauge never reach down over the head.
              className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full"
              style={{
                left: screenX,
                top: labelBottom,
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? 0.75 : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div
                className={`flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs ${needsApproval ? 'approval-glow' : ''}`}
              >
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {teamRoleLabel && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                        fontWeight: ch.isTeamLead ? 'bold' : undefined,
                      }}
                    >
                      {teamRoleLabel}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                    }}
                  >
                    {activityText}
                  </span>
                  {ch.directoryName && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {ch.directoryName}
                    </span>
                  )}
                </div>
              </div>
              {showContextGauge && (
                <ContextBar
                  used={contextRatio}
                  width={CONTEXT_GAUGE_WIDTH_PX}
                  height={CONTEXT_GAUGE_HEIGHT_PX}
                  style={{ marginTop: CONTEXT_GAUGE_GAP_PX }}
                  title={`${Math.round(contextLeft(contextRatio) * 100)}% context left (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens used)`}
                  testId="context-gauge"
                  pct={Math.round(contextRatio * 100)}
                />
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
