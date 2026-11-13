import { useEffect, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import type { Toast } from '../office/notifications.js';
import {
  dismissToast,
  getToasts,
  pauseToast,
  resumeToast,
  useNotificationsVersion,
} from '../office/notifications.js';
import { getPendingPermission } from '../office/permissionRequests.js';
import { PermissionButtons } from './PermissionButtons.js';

const KIND_LABEL: Record<Toast['kind'], { glyph: string; label: string }> = {
  approval: { glyph: '!', label: 'Needs approval:' },
  failed: { glyph: '×', label: 'Failed:' },
  finished: { glyph: '✓', label: 'Done:' },
};

function ToastItem({
  toast,
  officeState,
  now,
}: {
  toast: Toast;
  officeState: OfficeState;
  now: number;
}) {
  const { glyph, label } = KIND_LABEL[toast.kind];
  // Deny only here; approving happens in the panel, where the full request shows.
  const pending = toast.kind === 'approval' ? getPendingPermission(toast.agentId) : undefined;
  return (
    <div
      className={`pointer-events-auto pixel-panel flex items-center gap-6 text-sm ${
        toast.kind === 'approval' ? 'approval-glow' : ''
      }`}
      onMouseEnter={() => pauseToast(toast.key)}
      onMouseLeave={() => resumeToast(toast.key)}
      onFocus={() => pauseToast(toast.key)}
      onBlur={() => resumeToast(toast.key)}
      data-testid="agent-toast"
    >
      <button
        type="button"
        className="px-10 py-4 cursor-pointer whitespace-nowrap text-left"
        onClick={() => {
          officeState.selectedAgentId = toast.agentId;
          dismissToast(toast.key);
        }}
      >
        <span aria-hidden="true">{glyph} </span>
        <span className="sr-only">{label} </span>
        {toast.text}
      </button>
      {toast.kind === 'approval' && pending && (
        <span className="px-4">
          <PermissionButtons request={pending} now={now} compact />
        </span>
      )}
      <button
        type="button"
        className="pr-8 cursor-pointer text-text-muted hover:text-text"
        onClick={() => dismissToast(toast.key)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

/**
 * The office's quiet notifications, top-centre. Both live regions stay
 * mounted (empty when quiet) so screen readers announce the first notice too:
 * approval requests assertively, the rest politely. Clicking a notice opens
 * that agent's panel.
 */
export function AgentToasts({ officeState }: { officeState: OfficeState }) {
  useNotificationsVersion();
  // Ticks the approval countdown while a toast is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const toasts = getToasts();
  const urgent = toasts.filter((t) => t.kind === 'approval');
  const quiet = toasts.filter((t) => t.kind !== 'approval');
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-40 z-20 flex flex-col items-center gap-4 pointer-events-none">
      <div aria-live="assertive" role="alert" className="flex flex-col items-center gap-4">
        {urgent.map((t) => (
          <ToastItem key={t.key} toast={t} officeState={officeState} now={now} />
        ))}
      </div>
      <div aria-live="polite" role="status" className="flex flex-col items-center gap-4">
        {quiet.map((t) => (
          <ToastItem key={t.key} toast={t} officeState={officeState} now={now} />
        ))}
      </div>
    </div>
  );
}
