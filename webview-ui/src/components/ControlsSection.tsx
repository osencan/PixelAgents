import { useState } from 'react';

import { getControlAccess, useControlVersion } from '../office/controlAccess.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';

const INPUT_CLASS = 'text-xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text w-100';

function lockText(lockedUntil: number | undefined): string {
  if (!lockedUntil) return 'Too many wrong PINs; try again later.';
  const at = new Date(lockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Too many wrong PINs; try again after ${at}.`;
}

/**
 * Agent control for this browser (tokened pages only). On the server's own
 * machine control is on with the token, and the control PIN is set here. On
 * any other device control needs the PIN, and an unlock lapses after 30
 * minutes without control actions.
 */
export function ControlsSection() {
  useControlVersion();
  const access = getControlAccess();
  const [pin, setPin] = useState('');
  // Turning remote Directories on waits for the warning to be accepted.
  const [confirmRemoteDirs, setConfirmRemoteDirs] = useState(false);
  const setRemoteDirectories = (enabled: boolean) => {
    transport.send({ type: 'setRemoteDirectories', enabled });
    setConfirmRemoteDirs(false);
  };

  const submit = (type: 'unlockControl' | 'setControlPin') => {
    transport.send({ type, pin });
    setPin('');
  };
  const pinInput = (onEnter: () => void) => (
    <input
      type="password"
      inputMode="numeric"
      autoComplete="off"
      value={pin}
      maxLength={12}
      onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && pin.length >= 6) onEnter();
      }}
      className={INPUT_CLASS}
      aria-label="Control PIN (6-12 digits)"
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="controls-section">
      <span className="text-text-muted pt-4">Agent controls</span>
      {access.local ? (
        <>
          <span className="leading-tight">On: this is the computer running Pixel Agents.</span>
          <span className="text-text-muted leading-tight">
            {access.pinSet
              ? 'A PIN is set. Other devices (phone, tablet, another computer) enter it in their own Settings → Agent controls to unlock. Change it:'
              : 'Set a PIN (6-12 digits) here. Other devices (phone, tablet, another computer) then enter it in their own Settings → Agent controls to unlock controls:'}
          </span>
          <span className="flex items-center gap-4">
            {pinInput(() => submit('setControlPin'))}
            <Button size="sm" disabled={pin.length < 6} onClick={() => submit('setControlPin')}>
              {access.pinSet ? 'Change' : 'Set'}
            </Button>
          </span>
          <Checkbox
            label="Unlocked devices can add Directories"
            title="Lets a device unlocked with the PIN add and edit Directories, and so launch agents in any folder on this computer"
            checked={access.remoteDirectories || confirmRemoteDirs}
            onChange={() => {
              if (access.remoteDirectories) setRemoteDirectories(false);
              else setConfirmRemoteDirs(!confirmRemoteDirs);
            }}
          />
          {confirmRemoteDirs && !access.remoteDirectories && (
            <span className="flex flex-col gap-4 px-10">
              <span className="leading-tight">
                Security risk: a device unlocked with the PIN could then pick any folder on this
                computer and start agents in it, with your user's access to everything there. Anyone
                who learns the PIN (and over plain HTTP it crosses your network unencrypted) gets
                the same. Only allow this on a network and with devices you trust.
              </span>
              <span className="flex items-center gap-4">
                <Button size="sm" variant="accent" onClick={() => setRemoteDirectories(true)}>
                  I accept the risk, allow
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemoteDirs(false)}>
                  Cancel
                </Button>
              </span>
            </span>
          )}
        </>
      ) : access.control ? (
        <>
          <span className="leading-tight">Unlocked. Locks after 30 minutes without use.</span>
          <Button size="sm" variant="ghost" onClick={() => transport.send({ type: 'lockControl' })}>
            Lock
          </Button>
        </>
      ) : !access.pinSet ? (
        <span className="text-text-muted leading-tight">
          No control PIN yet. On the computer running Pixel Agents, set one in Settings → Agent
          controls, then enter it here.
        </span>
      ) : (
        <>
          <span className="text-text-muted leading-tight">
            Enter the control PIN set on the computer running Pixel Agents:
          </span>
          <span className="flex items-center gap-4">
            {pinInput(() => submit('unlockControl'))}
            <Button size="sm" disabled={pin.length < 6} onClick={() => submit('unlockControl')}>
              Unlock
            </Button>
          </span>
          {access.error === 'wrong' && <span className="leading-tight">Wrong PIN.</span>}
          {access.error === 'locked' && (
            <span className="leading-tight">{lockText(access.lockedUntil)}</span>
          )}
          <span className="text-text-muted leading-tight">
            Over plain HTTP the PIN crosses your network unencrypted.
          </span>
        </>
      )}
    </div>
  );
}
