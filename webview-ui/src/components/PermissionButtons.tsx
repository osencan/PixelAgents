import { getControlAccess, useControlVersion } from '../office/controlAccess.js';
import type { PendingPermission } from '../office/permissionRequests.js';
import { answerPermission, usePermissionsVersion } from '../office/permissionRequests.js';
import { Button } from './ui/Button.js';

function remaining(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Answers for ONE displayed permission request, when this connection has
 * control. In the panel, the full request is shown above the buttons and
 * Approve needs it complete; in a notification (compact) only Deny is offered,
 * since the full request isn't shown there. The terminal keeps working.
 */
export function PermissionButtons({
  request,
  now,
  compact = false,
}: {
  request: PendingPermission;
  now: number;
  compact?: boolean;
}) {
  usePermissionsVersion();
  useControlVersion();
  const { control } = getControlAccess();
  if (!control) {
    if (compact) return null;
    return (
      <span className="text-text-muted leading-tight">
        Unlock agent controls (Filter panel) to answer here, or answer in the terminal.
      </span>
    );
  }
  if (request.sent) {
    return (
      <span className="leading-tight">{request.sent === 'allow' ? 'Approving…' : 'Denying…'}</span>
    );
  }
  const deny = (
    <Button size="sm" onClick={() => answerPermission(request.requestId, 'deny')}>
      Deny
    </Button>
  );
  if (compact) return deny;
  return (
    <span className="flex flex-col gap-4" data-testid="permission-buttons">
      {request.detail !== undefined && (
        <pre
          className="max-h-160 overflow-auto whitespace-pre-wrap break-all bg-bg-dark border-2 border-border p-4 text-xs"
          data-testid="permission-detail"
        >
          {request.detail}
        </pre>
      )}
      <span className="flex flex-wrap items-center gap-6">
        <Button
          size="sm"
          variant={request.complete ? 'accent' : 'disabled'}
          disabled={!request.complete}
          onClick={() => answerPermission(request.requestId, 'allow')}
          title={
            request.complete
              ? 'Approve exactly the request shown above'
              : 'Too long to review here: approve it in the terminal'
          }
        >
          Approve
        </Button>
        {deny}
        <span className="text-text-muted">
          {remaining(request.expiresAt, now)} left here; terminal works too
        </span>
      </span>
      {!request.complete && (
        <span className="leading-tight">
          Too long to review here in full: approve it in the terminal, or deny here.
        </span>
      )}
    </span>
  );
}
