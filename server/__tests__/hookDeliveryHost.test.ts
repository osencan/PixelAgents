import { describe, expect, it } from 'vitest';

import { deliveryHost } from '../src/providers/hook/claude/hooks/serverRegistry.js';

const base = { port: 3100, pid: 1, token: 't', startedAt: 0, servesSpa: true, protocol: 1 };
const standalone = (host: string) => ({
  ...base,
  standalone: { terminal: false, host, allowedHosts: [] },
});

describe('deliveryHost', () => {
  it('posts to the specific address a LAN-bound server listens on', () => {
    expect(deliveryHost(standalone('192.168.1.20'))).toBe('192.168.1.20');
    expect(deliveryHost(standalone('[fd00::5]'))).toBe('fd00::5');
  });

  it('uses loopback for loopback, wildcard, embedded and legacy servers', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '']) {
      expect(deliveryHost(standalone(host))).toBe('127.0.0.1');
    }
    expect(deliveryHost(base)).toBe('127.0.0.1');
    expect(deliveryHost({ port: 3100, pid: 1, token: 't' })).toBe('127.0.0.1');
  });
});
