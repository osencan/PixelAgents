import { describe, expect, it } from 'vitest';

import { classifyCheckCommand } from '../src/checkCommands.js';

describe('classifyCheckCommand', () => {
  it('recognises test and build runs, tests first', () => {
    for (const c of [
      'npm test',
      'npm run test:webview',
      'pnpm test',
      'npx vitest run',
      'pytest -q',
      'go test ./...',
      'cargo test',
    ])
      expect(classifyCheckCommand(c), c).toBe('test');
    for (const c of [
      'npm run build',
      'npm run build -w webview-ui',
      'tsc -b',
      'node esbuild.js --production',
      'cargo build',
      'make',
    ])
      expect(classifyCheckCommand(c), c).toBe('build');
    expect(classifyCheckCommand('npm run build && npm test')).toBe('test');
  });

  it('ignores other commands, including look-alike words', () => {
    for (const c of [
      'ls -la',
      'git status',
      'echo test',
      'cat build.log',
      'npm install',
      'grep -r testing .',
      'makefile-lint',
    ])
      expect(classifyCheckCommand(c), c).toBeUndefined();
  });
});
