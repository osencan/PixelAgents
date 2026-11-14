import { ambientEnabled, setAmbientEnabled, useAmbientVersion } from '../office/ambient.js';
import { linkLinesEnabled, setLinkLinesEnabled, useLinkLinesVersion } from '../office/linkLines.js';
import {
  notificationsEnabled,
  setNotificationsEnabled,
  useNotificationsVersion,
} from '../office/notifications.js';
import { Checkbox } from './ui/Checkbox.js';

/** Switches saved in this browser only: in Settings, or in the Filter panel
 *  of a page opened without the token (it has no Settings). */
export function BrowserPrefs() {
  useNotificationsVersion();
  useAmbientVersion();
  useLinkLinesVersion();
  return (
    <>
      <Checkbox
        label="Notifications"
        checked={notificationsEnabled()}
        onChange={() => setNotificationsEnabled(!notificationsEnabled())}
        title="Approval requests, finished turns and failed tools"
      />
      <Checkbox
        label="Day/night tint"
        checked={ambientEnabled()}
        onChange={() => setAmbientEnabled(!ambientEnabled())}
        title="Decoration only: follows your clock, not agent activity"
      />
      <Checkbox
        label="Lines to subagents"
        checked={linkLinesEnabled()}
        onChange={() => setLinkLinesEnabled(!linkLinesEnabled())}
        title="Dashed lines from the selected agent to its lead and its subagents"
      />
    </>
  );
}
