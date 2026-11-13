import type { ToolActivity } from './types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
export const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

export const NEEDS_APPROVAL_TEXT = 'Needs approval';

/** Derive a short human-readable activity string from tools/status */
export function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return NEEDS_APPROVAL_TEXT;
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return NEEDS_APPROVAL_TEXT;
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

/** The tool an agent is asking approval for: the newest unfinished one that is
 *  flagged, else (a bubble-only permission) the newest unfinished one. */
export function pendingApprovalTool(
  tools: ToolActivity[] | undefined,
  hasPermissionBubble: boolean,
): ToolActivity | undefined {
  const open = (tools ?? []).filter((t) => !t.done).reverse();
  return open.find((t) => t.permissionWait) ?? (hasPermissionBubble ? open[0] : undefined);
}

/** Provider name from the label the server gives Codex characters. */
export function providerName(directoryName: string | undefined): string {
  return directoryName?.startsWith('Codex') ? 'Codex' : 'Claude';
}

/**
 * Refine the tool-based activity text with the server's lifecycle: mid-turn
 * with no tool running, the last tool's line is stale -- say "Thinking".
 */
export function lifecycleAwareText(
  text: string,
  tools: ToolActivity[] | undefined,
  lifecycle: string | undefined,
): string {
  const toolRunning = (tools ?? []).some((t) => !t.done);
  if (lifecycle === 'thinking' && !toolRunning) return 'Thinking';
  return text;
}
