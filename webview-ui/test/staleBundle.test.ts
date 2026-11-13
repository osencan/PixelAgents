import { describe, expect, it, vi } from 'vitest';

import { reloadIfBundleChanged, reloadIfStale } from '../src/staleBundle.js';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('reloadIfStale', () => {
  it('reloads once when the server runs another version', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadIfStale('2.0.0', '1.6.0', storage, reload)).toBe(true);
    // Served the old page again (a cache): no reload loop.
    expect(reloadIfStale('2.0.0', '1.6.0', storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // A later update reloads again.
    expect(reloadIfStale('2.1.0', '1.6.0', storage, reload)).toBe(true);
  });

  it('does nothing when versions match or are unknown', () => {
    const reload = vi.fn();
    expect(reloadIfStale('2.0.0', '2.0.0', memoryStorage(), reload)).toBe(false);
    expect(reloadIfStale('', '2.0.0', memoryStorage(), reload)).toBe(false);
    expect(reloadIfStale('2.0.0', '', memoryStorage(), reload)).toBe(false);
    expect(reloadIfStale('2.0.0', '1.6.0', null, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('reloadIfBundleChanged', () => {
  const page = (hash: string) => async () =>
    `<script type="module" crossorigin src="./assets/index-${hash}.js"></script>`;

  it('reloads once when the server serves another build of the same version', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const running = 'assets/index-OLD123.js';
    expect(await reloadIfBundleChanged(page('NEW456'), running, storage, reload)).toBe(true);
    expect(await reloadIfBundleChanged(page('NEW456'), running, storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing for the same build, an unreadable page, or no entry script', async () => {
    const reload = vi.fn();
    const running = 'assets/index-SAME.js';
    expect(await reloadIfBundleChanged(page('SAME'), running, memoryStorage(), reload)).toBe(false);
    const failing = () => Promise.reject(new Error('offline'));
    expect(await reloadIfBundleChanged(failing, running, memoryStorage(), reload)).toBe(false);
    expect(await reloadIfBundleChanged(page('NEW'), null, memoryStorage(), reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
