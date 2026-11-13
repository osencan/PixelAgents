import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signDecision } from '../src/permissionSignature.js';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/claude-hook.js');
let tmpBase: string;

function writeRegistryEntry(port: number, pid: number): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({
      port,
      pid,
      token: 't',
      decisionKey: 'k',
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    }),
  );
}

/** A server answering the decision route after `delayMs` with `decision`. */
/** Answers the decision route after `delayMs`, signed with the registry's
 *  decision key 'k' (or with `signKey`; empty = unsigned). */
function startDecider(
  decision: string | null,
  delayMs: number,
  signKey = 'k',
): Promise<{ port: number; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume();
    req.on('end', () =>
      setTimeout(() => {
        const nonce = String(req.headers['x-pixel-agents-nonce'] ?? '');
        const signature = signKey && decision ? signDecision(signKey, nonce, decision) : undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision, signature }));
      }, delayMs),
    );
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        paths,
        close: () => server.closeAllConnections?.() ?? server.close(),
      }),
    ),
  );
}

function runHook(
  event: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

const permissionEvent = {
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-perm',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};

describe('claude-hook.js permission decisions', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-perm-'));
  });
  afterEach(() => fs.rmSync(tmpBase, { recursive: true, force: true }));
  const itBuilt = it.skipIf(!fs.existsSync(HOOK_SCRIPT));

  itBuilt('prints the documented Claude decision JSON when the office answers', async () => {
    const s = await startDecider('allow', 50);
    writeRegistryEntry(s.port, process.pid);
    const { code, stdout } = await runHook(permissionEvent);
    s.close();
    expect(code).toBe(0);
    expect(s.paths).toEqual(['/api/hooks/claude/permission']);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  itBuilt('prints nothing without a decision, leaving the terminal prompt in charge', async () => {
    const s = await startDecider(null, 50);
    writeRegistryEntry(s.port, process.pid);
    const { code, stdout } = await runHook(permissionEvent);
    s.close();
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  itBuilt('takes the first decision across servers without waiting for the rest', async () => {
    const slow = await startDecider(null, 8000);
    const fast = await startDecider('deny', 100);
    writeRegistryEntry(slow.port, process.pid);
    writeRegistryEntry(fast.port, process.ppid);
    const { stdout, ms } = await runHook(permissionEvent);
    slow.close();
    fast.close();
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    expect(ms).toBeLessThan(5000);
  });

  itBuilt(
    'ignores an unsigned answer: something else on the port cannot approve (review fix)',
    async () => {
      const s = await startDecider('allow', 20, '');
      writeRegistryEntry(s.port, process.pid);
      const { stdout } = await runHook(permissionEvent);
      s.close();
      expect(stdout).toBe('');
    },
  );

  itBuilt(
    'an answer signed with the bearer token (which a port squatter receives) is ignored',
    async () => {
      const s = await startDecider('allow', 20, 't');
      writeRegistryEntry(s.port, process.pid);
      const { stdout } = await runHook(permissionEvent);
      s.close();
      expect(stdout).toBe('');
    },
  );

  itBuilt('a deny wins over an allow from another server (review fix)', async () => {
    const allow = await startDecider('allow', 20);
    const deny = await startDecider('deny', 120);
    writeRegistryEntry(allow.port, process.pid);
    writeRegistryEntry(deny.port, process.ppid);
    const { stdout } = await runHook(permissionEvent);
    allow.close();
    deny.close();
    expect(JSON.parse(stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  itBuilt('other events keep the fast fire-and-forget path', async () => {
    const s = await startDecider('allow', 0);
    writeRegistryEntry(s.port, process.pid);
    const { stdout } = await runHook({ ...permissionEvent, hook_event_name: 'PreToolUse' });
    s.close();
    expect(s.paths).toEqual(['/api/hooks/claude']);
    expect(stdout).toBe('');
  });
});
