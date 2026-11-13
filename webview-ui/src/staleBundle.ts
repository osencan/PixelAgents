/**
 * A page left open across a server update keeps running its old code: the
 * reconnect restores the socket, not the page. The server reports its version,
 * so a page whose own version differs reloads itself, once per tab and version
 * (no loop if a cache serves the old page again).
 */
declare const __PIXEL_AGENTS_VERSION__: string | undefined;

/** The version this page was built as ('' when not inlined, e.g. in tests). */
export const BUNDLE_VERSION: string =
  typeof __PIXEL_AGENTS_VERSION__ === 'string' ? __PIXEL_AGENTS_VERSION__ : '';

/** Like Cmd+Shift+R: refresh the cached page first, so the reload gets the new code. */
function reloadBypassingCache(): void {
  void fetch(window.location.href, { cache: 'reload' })
    .catch(() => undefined)
    .finally(() => window.location.reload());
}

const RELOADED_FOR_KEY = 'pixel-agents.reloadedForVersion';

/** Reload when the server runs a different version than this page. True if it reloaded. */
export function reloadIfStale(
  serverVersion: string,
  bundleVersion = BUNDLE_VERSION,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.sessionStorage ?? null,
  reload: () => void = reloadBypassingCache,
): boolean {
  if (!serverVersion || !bundleVersion || serverVersion === bundleVersion) return false;
  try {
    if (!storage || storage.getItem(RELOADED_FOR_KEY) === serverVersion) return false;
    storage.setItem(RELOADED_FOR_KEY, serverVersion);
  } catch {
    return false;
  }
  reload();
  return true;
}

// ── Same version, new build ──────────────────────────────────────
// A redeploy without a version bump (a fix, a trial build) leaves the
// version check blind. The served index.html names the current entry script
// (hashed per build), so a page compares that with the script it runs.

const ENTRY_SCRIPT = /assets\/index-[\w-]+\.js/;
const RELOADED_FOR_BUNDLE_KEY = 'pixel-agents.reloadedForBundle';

/** The entry script this page runs ("assets/index-<hash>.js"), if any. */
function runningBundle(): string | null {
  for (const script of document.querySelectorAll('script[src]')) {
    const match = ENTRY_SCRIPT.exec(script.getAttribute('src') ?? '');
    if (match) return match[0];
  }
  return null;
}

/** Reload when the server now serves a different build. True if it reloaded. */
export async function reloadIfBundleChanged(
  fetchPage: () => Promise<string> = () =>
    fetch(window.location.href, { cache: 'no-store' }).then((r) => r.text()),
  running: string | null = runningBundle(),
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.sessionStorage ?? null,
  reload: () => void = reloadBypassingCache,
): Promise<boolean> {
  if (!running) return false;
  let served: string | undefined;
  try {
    served = ENTRY_SCRIPT.exec(await fetchPage())?.[0];
  } catch {
    return false;
  }
  if (!served || served === running) return false;
  try {
    if (!storage || storage.getItem(RELOADED_FOR_BUNDLE_KEY) === served) return false;
    storage.setItem(RELOADED_FOR_BUNDLE_KEY, served);
  } catch {
    return false;
  }
  reload();
  return true;
}
