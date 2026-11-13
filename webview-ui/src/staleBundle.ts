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
