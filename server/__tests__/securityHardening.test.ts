import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pngToSpriteData } from '../../core/src/assets/pngDecoder.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { loadExternalCharacterSprites, loadFurnitureAssets } from '../src/assetLoader.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import {
  CONTROL_PIN_GLOBAL_MAX_FAILURES,
  onControlPolicyChange,
  pinRateLimitKey,
  remoteDirectoriesAllowed,
  resetControlPolicyForTests,
  setControlPin,
  verifyControlPin,
} from '../src/controlPolicy.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { writeJsonAtomic } from '../src/jsonFileWatcher.js';
import { readLayoutFromFile } from '../src/layoutPersistence.js';
import { resolveProject } from '../src/projectIdentity.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { startPtyHost } from '../src/terminal/ptyHost.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { PRIVILEGED_BROADCAST_TYPES } from '../src/usageLimits.js';

describe('security hardening regressions', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sec-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    resetControlPolicyForTests();
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('M1: tokenless viewers never receive usageLimits, directoriesLoaded, or externalAssetDirectories', () => {
    const projectDir = path.join(tempHome, 'secret-project');
    const assetDir = path.join(tempHome, 'secret-assets');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(assetDir);
    const cfg = readConfig();
    cfg.directories = [{ name: 'Secret', path: projectDir }];
    cfg.externalAssetDirectories = [assetDir];
    writeConfig(cfg);

    const ptyManager = PtySessionManager.disabled('off');
    const untokened: ClientMessageContext = {
      store,
      cache: null,
      privileged: false,
      control: false,
      local: false,
      ptyManager,
    };

    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), untokened);
    expect(sent.map((m) => m.type)).not.toContain('directoriesLoaded');
    const settings = sent.find((m) => m.type === 'settingsLoaded');
    expect(settings?.externalAssetDirectories).toEqual([]);

    sent = [];
    handleClientMessage(
      { type: 'setUsageBridgeEnabled', providerId: 'claude', enabled: true },
      (m) => sent.push(m),
      untokened,
    );
    expect(sent).toEqual([]);

    handleClientMessage(
      { type: 'addExternalAssetDirectory', path: '/etc' },
      (m) => sent.push(m),
      untokened,
    );
    expect(sent).toEqual([{ type: 'externalAssetDirectoriesUpdated', dirs: [] }]);

    expect(PRIVILEGED_BROADCAST_TYPES.has('directoriesLoaded')).toBe(true);
    expect(PRIVILEGED_BROADCAST_TYPES.has('terminalSessionOpened')).toBe(true);
    expect(PRIVILEGED_BROADCAST_TYPES.has('terminalSessionClosed')).toBe(true);
  });

  it('H2: locked remote clients are refused directory, conversation, and diagnostic messages; remote saveDirectory is refused even with control', () => {
    const target = path.join(tempHome, 'proj');
    fs.mkdirSync(target);
    const ptyManager = PtySessionManager.disabled('off');

    const lockedRemote: ClientMessageContext = {
      store,
      cache: null,
      privileged: true,
      control: false,
      local: false,
      ptyManager,
    };
    for (const msg of [
      { type: 'saveDirectory', name: 'P', path: target },
      { type: 'removeDirectory', path: target },
      { type: 'requestDirectorySuggestions' },
      { type: 'requestConversations' },
      { type: 'searchConversations', query: 'secret', limit: 10 },
      { type: 'requestDiagnostics' },
      { type: 'setShowHostDirectories', enabled: true },
      { type: 'setWatchAllSessions', enabled: true },
    ]) {
      sent = [];
      handleClientMessage(msg, (m) => sent.push(m), lockedRemote);
      expect(sent).toContainEqual({ type: 'controlRefused', action: msg.type });
    }
    expect(readConfig().directories).toEqual([]);

    // Even after PIN unlock (control: true), remote clients cannot add new launch directories.
    sent = [];
    const unlockedRemote: ClientMessageContext = {
      store,
      cache: null,
      privileged: true,
      control: true,
      local: false,
      ptyManager,
    };
    handleClientMessage(
      { type: 'saveDirectory', name: 'P', path: target },
      (m) => sent.push(m),
      unlockedRemote,
    );
    expect(sent).toContainEqual({ type: 'controlRefused', action: 'saveDirectory' });
    expect(readConfig().directories).toEqual([]);
  });

  it('remote Directories: only the host turns them on, then unlocked (not locked) devices may add', () => {
    const target = path.join(tempHome, 'proj');
    fs.mkdirSync(target);
    const ptyManager = PtySessionManager.disabled('off');
    const ctx = (control: boolean, local: boolean): ClientMessageContext => ({
      store,
      cache: null,
      privileged: true,
      control,
      local,
      ptyManager,
    });
    const changes: number[] = [];
    const unwatch = onControlPolicyChange(() => changes.push(1));

    // A device can't allow itself, even unlocked.
    handleClientMessage(
      { type: 'setRemoteDirectories', enabled: true },
      (m) => sent.push(m),
      ctx(true, false),
    );
    expect(sent).toContainEqual({ type: 'controlRefused', action: 'setRemoteDirectories' });
    expect(remoteDirectoriesAllowed()).toBe(false);
    expect(changes).toEqual([]);

    // The host allows it: every connection is told.
    handleClientMessage(
      { type: 'setRemoteDirectories', enabled: true },
      (m) => sent.push(m),
      ctx(true, true),
    );
    expect(remoteDirectoriesAllowed()).toBe(true);
    expect(changes).toEqual([1]);
    unwatch();

    // A locked device is still refused; an unlocked one may add.
    sent = [];
    handleClientMessage(
      { type: 'saveDirectory', name: 'P', path: target },
      (m) => sent.push(m),
      ctx(false, false),
    );
    expect(sent).toContainEqual({ type: 'controlRefused', action: 'saveDirectory' });
    expect(readConfig().directories).toEqual([]);
    handleClientMessage(
      { type: 'saveDirectory', name: 'P', path: target },
      (m) => sent.push(m),
      ctx(true, false),
    );
    expect(readConfig().directories.map((d) => d.path)).toEqual([target]);

    // Turned off again, the next remote add is refused.
    handleClientMessage(
      { type: 'setRemoteDirectories', enabled: false },
      (m) => sent.push(m),
      ctx(true, true),
    );
    sent = [];
    handleClientMessage(
      { type: 'saveDirectory', name: 'Q', path: tempHome },
      (m) => sent.push(m),
      ctx(true, false),
    );
    expect(sent).toContainEqual({ type: 'controlRefused', action: 'saveDirectory' });

    // Deleting only narrows reach: any unlocked device may, even with adding off.
    handleClientMessage(
      { type: 'removeDirectory', path: target },
      (m) => sent.push(m),
      ctx(true, false),
    );
    expect(readConfig().directories).toEqual([]);
  });

  it('M2: pinRateLimitKey isolates proxied clients only when trustProxy + local peer, and loopback never enters knownGood', () => {
    expect(
      pinRateLimitKey('127.0.0.1', { 'tailscale-user-login': 'Alice@Example.com' }, true),
    ).toBe('ts:alice@example.com');
    expect(
      pinRateLimitKey('127.0.0.1', { 'x-forwarded-for': '203.0.113.5, 198.51.100.9' }, true),
    ).toBe('198.51.100.9');
    // Untrusted proxy flag or non-local peer ignores forwarding headers.
    expect(pinRateLimitKey('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' }, false)).toBe(
      '127.0.0.1',
    );
    expect(pinRateLimitKey('192.0.2.10', { 'tailscale-user-login': 'spoofed' }, true)).toBe(
      '192.0.2.10',
    );

    setControlPin('482913');
    const now = 50_000_000;
    // Unlocking via loopback does not whitelist 127.0.0.1 against global pause.
    expect(verifyControlPin('482913', '127.0.0.1', now)).toEqual({ ok: true });
    for (let i = 0; i < CONTROL_PIN_GLOBAL_MAX_FAILURES; i++) {
      verifyControlPin('000000', `10.9.${i}.1`, now);
    }
    expect(verifyControlPin('482913', '127.0.0.1', now + 1)).toMatchObject({
      ok: false,
      reason: 'locked',
    });
  });

  it('M4: verifyControlPin rejects malformed/huge PINs fast, and saveLayout/saveAreaMappings validate payloads', () => {
    setControlPin('482913');
    const start = Date.now();
    const verdict = verifyControlPin('x'.repeat(2_000_000), '203.0.113.55');
    expect(verdict).toEqual({ ok: false, reason: 'wrong' });
    expect(Date.now() - start).toBeLessThan(100);

    const localCtx: ClientMessageContext = {
      store,
      cache: null,
      privileged: true,
      control: true,
      local: true,
    };
    handleClientMessage(
      { type: 'saveLayout', layout: { cols: 9999, rows: 9999, tiles: [] } },
      () => {},
      localCtx,
    );
    expect(readLayoutFromFile()).toBeNull();

    handleClientMessage(
      { type: 'saveAreaMappings', mappings: { valid: ['a', 123, 'b'], bad: 'nope' } },
      () => {},
      localCtx,
    );
    expect(readConfig().standalone.areaMappings).toEqual({ valid: ['a', 'b'] });
  });

  it('M5: state files are created 0600 inside 0700 dirs, and ptyHost refuses a shared socket directory', async () => {
    setControlPin('482913');
    writeConfig(readConfig());
    store.getAdapter()!.saveCardOrder!([1]);
    const customFile = path.join(tempHome, '.pixel-agents', 'test.json');
    writeJsonAtomic(customFile, { ok: true });

    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(path.join(tempHome, '.pixel-agents')).mode & 0o777;
      expect(dirMode).toBe(0o700);
      for (const name of ['control.json', 'config.json', 'standalone-state.json', 'test.json']) {
        const mode = fs.statSync(path.join(tempHome, '.pixel-agents', name)).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const sharedDir = path.join(tempHome, 'shared');
      fs.mkdirSync(sharedDir, { mode: 0o777 });
      fs.chmodSync(sharedDir, 0o777);
      await expect(startPtyHost({ socketPath: path.join(sharedDir, 'host.sock') })).rejects.toThrow(
        /owner-only/,
      );
    }
  });

  it('L2: pngToSpriteData bounds dimensions and assetLoader blocks symlinks outside asset directories', async () => {
    expect(pngToSpriteData(Buffer.alloc(0), 10_000, 10_000)).toEqual([]);
    expect(pngToSpriteData(Buffer.alloc(0), -1, 16)).toEqual([]);

    const outside = path.join(tempHome, 'outside.png');
    fs.writeFileSync(outside, Buffer.alloc(64));

    const extRoot = path.join(tempHome, 'ext');
    const itemDir = path.join(extRoot, 'assets', 'furniture', 'desk');
    fs.mkdirSync(itemDir, { recursive: true });
    fs.symlinkSync(outside, path.join(itemDir, 'desk.png'));
    fs.writeFileSync(
      path.join(itemDir, 'manifest.json'),
      JSON.stringify({
        type: 'asset',
        id: 'desk',
        name: 'Desk',
        category: 'desks',
        file: 'desk.png',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
      }),
    );
    const loaded = await loadFurnitureAssets(extRoot);
    expect(loaded?.sprites.size ?? 0).toBe(0);

    const charDir = path.join(extRoot, 'assets', 'characters');
    fs.mkdirSync(charDir, { recursive: true });
    fs.symlinkSync(outside, path.join(charDir, 'char_0.png'));
    expect(await loadExternalCharacterSprites(extRoot)).toBeNull();
  });

  it('L3 & L4: worktreeMainRoot rejects spoofed .git pointers and getTeamMembers rejects traversal names', () => {
    const main = path.join(tempHome, 'OptedInRepo');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'legit'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'legit', 'commondir'), '../..\n');
    const legitWt = path.join(tempHome, 'legit-wt');
    fs.mkdirSync(legitWt);
    fs.writeFileSync(
      path.join(main, '.git', 'worktrees', 'legit', 'gitdir'),
      `${path.join(legitWt, '.git')}\n`,
    );

    // Crafted untrusted folder with a fake gitdir outside main/.git/worktrees
    const fakeGitDir = path.join(tempHome, 'fake-gitdir');
    fs.mkdirSync(fakeGitDir);
    fs.writeFileSync(path.join(fakeGitDir, 'commondir'), path.join(main, '.git'));
    const untrusted = path.join(tempHome, 'untrusted');
    fs.mkdirSync(untrusted);
    fs.writeFileSync(path.join(untrusted, '.git'), `gitdir: ${fakeGitDir}\n`);
    expect(resolveProject(untrusted)?.root).toBe(untrusted);

    // Crafted untrusted folder pointing at a real worktree's gitdir (back-pointer mismatch)
    const spoofed = path.join(tempHome, 'spoofed');
    fs.mkdirSync(spoofed);
    fs.writeFileSync(
      path.join(spoofed, '.git'),
      `gitdir: ${path.join(main, '.git', 'worktrees', 'legit')}\n`,
    );
    expect(resolveProject(spoofed)?.root).toBe(spoofed);

    // L4: teamName path traversal refused
    const targetConfigDir = path.join(tempHome, '.claude', 'escape');
    fs.mkdirSync(targetConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetConfigDir, 'config.json'),
      JSON.stringify({ members: [{ name: 'leaked' }] }),
    );
    expect(claudeTeamProvider.getTeamMembers('../escape')).toBeNull();
    expect(claudeTeamProvider.getTeamMembers('a/b')).toBeNull();
  });
});
