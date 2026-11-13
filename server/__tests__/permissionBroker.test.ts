import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => home };
});

const { createAgentState } = await import('../src/agentState.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const policy = await import('../src/controlPolicy.js');
const { PermissionBroker, permissionDetail } = await import('../src/permissionBroker.js');

function setup(waitMs = 10_000) {
  const store = new AgentStateStore();
  const agent = createAgentState({
    id: 1,
    sessionId: 'sess-1',
    projectDir: '/w',
    jsonlFile: '/w/a.jsonl',
    isExternal: true,
  });
  agent.projectRoot = '/work/site';
  agent.directoryName = 'site';
  store.set(1, agent);
  const sent: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => sent.push(m));
  return { store, sent, broker: new PermissionBroker(store, waitMs) };
}
const event = {
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};
const never = () => {};
const controlSocket = {};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-broker-')));
  policy.resetControlPolicyForTests();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('PermissionBroker', () => {
  it('answers at once without opt-in or without a control client', async () => {
    const { broker } = setup();
    policy.setControlSocket(controlSocket, true);
    expect(await broker.ask(event, never)).toBeNull(); // project not opted in
    policy.setApprovalEnabled('/work/site', true);
    policy.setControlSocket(controlSocket, false);
    expect(await broker.ask(event, never)).toBeNull(); // nobody could answer
  });

  it('holds an opted-in request until a control client answers, then reports it', async () => {
    const { broker, sent } = setup();
    policy.setApprovalEnabled('/work/site', true);
    policy.setControlSocket(controlSocket, true);
    const answer = broker.ask(event, never);
    const pending = sent.find((m) => m.type === 'agentPermissionPending')!;
    expect(pending).toMatchObject({ id: 1, toolName: 'Bash', status: 'Running: npm test' });
    expect(broker.decide(pending.requestId as string, 'allow', 'remote')).toBe(true);
    expect(await answer).toBe('allow');
    expect(sent.at(-1)).toMatchObject({ type: 'agentPermissionResolved', outcome: 'allow' });
    // Answered once; a second answer does nothing. The audit names no command.
    expect(broker.decide(pending.requestId as string, 'deny', 'remote')).toBe(false);
    const audit = fs.readFileSync(path.join(home, '.pixel-agents', 'control-audit.jsonl'), 'utf8');
    expect(audit).toContain('permission-allow');
    expect(audit).not.toContain('npm test');
  });

  it('lets go when the session moves on, the hook goes away, or time runs out', async () => {
    const { broker, sent } = setup(1000);
    policy.setApprovalEnabled('/work/site', true);
    policy.setControlSocket(controlSocket, true);

    const moved = broker.ask(event, never);
    broker.observe({ hook_event_name: 'Notification', session_id: 'sess-1' }); // not a move
    broker.observe({ hook_event_name: 'PostToolUse', session_id: 'sess-1' });
    expect(await moved).toBeNull();
    expect(sent.at(-1)).toMatchObject({ outcome: 'elsewhere' });

    let abort = () => {};
    const withdrawn = broker.ask(event, (cb) => (abort = cb));
    abort();
    expect(await withdrawn).toBeNull();
    expect(sent.at(-1)).toMatchObject({ outcome: 'withdrawn' });

    vi.useFakeTimers();
    const timedOut = broker.ask(event, never);
    vi.advanceTimersByTime(1001);
    expect(await timedOut).toBeNull();
    expect(sent.at(-1)).toMatchObject({ outcome: 'timeout' });
  });

  it("uses the project of the request's cwd, before the agent is labelled", async () => {
    const { store, broker, sent } = setup();
    store.get(1)!.projectRoot = undefined;
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(home, 'proj-')));
    policy.setApprovalEnabled(dir, true);
    policy.setControlSocket(controlSocket, true);
    const answer = broker.ask({ ...event, cwd: dir }, never);
    const pending = sent.find((m) => m.type === 'agentPermissionPending')!;
    broker.decide(pending.requestId as string, 'deny', 'local');
    expect(await answer).toBe('deny');
  });

  it('shows the full request and refuses a browser approve when it is too long (review fix)', async () => {
    const long = 'echo ' + 'x'.repeat(9000);
    expect(permissionDetail('Edit', { file_path: '/abs/path/to/file.ts' })).toEqual({
      detail: '/abs/path/to/file.ts',
      complete: true,
    });
    const longCommand = 'rm -rf /tmp/a-long-path/' + 'y'.repeat(90);
    expect(permissionDetail('Bash', { command: longCommand })).toEqual({
      detail: longCommand,
      complete: true,
    });
    expect(permissionDetail('Bash', { command: long }).complete).toBe(false);
    // Anything beyond the command (here: backgrounding) shows the whole input.
    const background = permissionDetail('Bash', { command: 'npm start', run_in_background: true });
    expect(background.detail).toContain('run_in_background');
    // Hidden or reordering characters are shown as escapes and allow Deny only.
    const bidi = permissionDetail('Bash', { command: 'echo safe\u202E; rm -rf ~' });
    expect(bidi).toEqual({ detail: 'echo safe\\u202e; rm -rf ~', complete: false });
    expect(permissionDetail('Bash', { command: 'a\u200Bb\rc' }).detail).toBe('a\\u200bb\\u000dc');
    expect(permissionDetail('Bash', { command: 'printf "a\tb\n"' }).complete).toBe(true);
    // Beyond the usual suspects: tag characters, Hangul filler, private use.
    expect(permissionDetail('Bash', { command: 'ls \u{E0041}' }).detail).toBe('ls \\u{e0041}');
    expect(permissionDetail('Bash', { command: 'lsㅤ-la' }).complete).toBe(false);
    expect(permissionDetail('Bash', { command: 'echo ' }).complete).toBe(false);
    expect(permissionDetail('Bash', { command: 'echo café ünïcode' }).complete).toBe(true);
    expect(permissionDetail('Bash', { command: 'ls', description: 'List files' }).detail).toBe(
      'ls',
    );

    const { broker, sent } = setup();
    policy.setApprovalEnabled('/work/site', true);
    policy.setControlSocket(controlSocket, true);
    const answer = broker.ask({ ...event, tool_input: { command: long } }, never);
    const pending = sent.find((m) => m.type === 'agentPermissionPending')!;
    expect(pending).toMatchObject({ complete: false });
    expect(broker.decide(pending.requestId as string, 'allow', 'local')).toBe(false);
    expect(broker.decide(pending.requestId as string, 'deny', 'local')).toBe(true);
    expect(await answer).toBe('deny');
  });
});
