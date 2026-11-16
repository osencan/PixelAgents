import { STUCK_MINUTES_OPTIONS } from '../constants.js';
import { ambientEnabled, setAmbientEnabled, useAmbientVersion } from '../office/ambient.js';
import { linkLinesEnabled, setLinkLinesEnabled, useLinkLinesVersion } from '../office/linkLines.js';
import {
  notificationsEnabled,
  setNotificationsEnabled,
  useNotificationsVersion,
} from '../office/notifications.js';
import {
  longTurnsOnly,
  setLongTurnsOnly,
  setStuckMinutes,
  stuckMinutes,
  useStuckPrefsVersion,
} from '../office/stuckAgents.js';
import { Checkbox } from './ui/Checkbox.js';

/** Switches saved in this browser only: in Settings, or in the Filter panel
 *  of a page opened without the token (it has no Settings). */
export function BrowserPrefs() {
  useNotificationsVersion();
  useAmbientVersion();
  useLinkLinesVersion();
  useStuckPrefsVersion();
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
      <Checkbox
        label="Finished turns: only over a minute"
        checked={longTurnsOnly()}
        onChange={() => setLongTurnsOnly(!longTurnsOnly())}
        title="Stay quiet about quick turns; announce the ones you might have walked away from"
      />
      <label
        className="inline-flex items-center gap-8"
        title="A guess: a working agent with no news for this long, or an approval request still waiting"
      >
        <span>Quiet agents ("Stuck?")</span>
        <select
          className="text-xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text"
          value={stuckMinutes()}
          onChange={(e) => setStuckMinutes(Number(e.target.value))}
          aria-label="Mark an agent Stuck? after this many quiet minutes"
        >
          {STUCK_MINUTES_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? 'Off' : `after ${m} min`}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
