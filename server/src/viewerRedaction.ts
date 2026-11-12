/**
 * What a read-only (tokenless) viewer may see of an agent's tool activity.
 *
 * Tool status lines carry file names, shell commands and subtask descriptions.
 * Tokened sockets get them verbatim; read-only sockets (e.g. a LAN viewer) get
 * a broad category instead. Pure, so the gate is unit-testable without a socket.
 */

const TOOL_STATUS_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'agentToolStart',
  'subagentToolStart',
]);

const SUBTASK_PREFIX = 'Subtask:';

/** Broad, content-free category for a tool status line. */
export function toolStatusCategory(status: string, toolName?: string): string {
  // The webview keys sub-agent characters off this prefix: keep it.
  if (status.startsWith(SUBTASK_PREFIX)) return `${SUBTASK_PREFIX} details hidden`;
  if (status.startsWith('Running')) return 'Running a command';
  if (status.startsWith('Editing') || status.startsWith('Writing')) return 'Editing a file';
  if (status.startsWith('Reading')) return 'Reading a file';
  if (status.startsWith('Searching') || status.startsWith('Fetching')) return status;
  if (status === 'Waiting for your answer') return status;
  switch (toolName) {
    case 'Bash':
      return 'Running a command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'Editing a file';
    case 'Read':
      return 'Reading a file';
    default:
      return 'Working';
  }
}

/** The message as a read-only viewer may receive it (same object when unchanged). */
export function redactForViewer(message: Record<string, unknown>): Record<string, unknown> {
  if (!TOOL_STATUS_MESSAGE_TYPES.has(String(message.type))) return message;
  if (typeof message.status !== 'string') return message;
  const toolName = typeof message.toolName === 'string' ? message.toolName : undefined;
  return { ...message, status: toolStatusCategory(message.status, toolName) };
}
