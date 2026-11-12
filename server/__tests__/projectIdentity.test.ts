import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { projectDisplayNames, resolveProject } from '../src/projectIdentity.js';

const dirs: string[] = [];
function temp(): string {
  // realpath: macOS tmpdir is itself a symlink (/var -> /private/var).
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-project-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveProject', () => {
  it('maps subdirectories to the enclosing git root', () => {
    const repo = path.join(temp(), 'Website');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src', 'pages'), { recursive: true });
    expect(resolveProject(path.join(repo, 'src', 'pages'))).toEqual({
      root: repo,
      name: 'Website',
    });
  });

  it('groups a linked worktree with its main repository', () => {
    const root = temp();
    const main = path.join(root, 'Watermark');
    const wt = path.join(root, 'watermark-feature');
    const wtGit = path.join(main, '.git', 'worktrees', 'watermark-feature');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(resolveProject(path.join(wt, 'lib'))).toEqual({
      root: main,
      name: 'Watermark',
      worktree: 'watermark-feature',
    });
  });

  it('treats a submodule or unreadable .git file as its own project', () => {
    const repo = path.join(temp(), 'vendor-lib');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: ../.git/modules/vendor-lib\n');
    expect(resolveProject(repo)).toEqual({ root: repo, name: 'vendor-lib' });
  });

  it('resolves symlinked paths to the real project', () => {
    const root = temp();
    const repo = path.join(root, 'RealRepo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const link = path.join(root, 'shortcut');
    fs.symlinkSync(repo, link);
    expect(resolveProject(link)?.root).toBe(repo);
  });

  it('falls back to the directory itself without a git root, and rejects relative paths', () => {
    const plain = path.join(temp(), 'notes');
    fs.mkdirSync(plain);
    expect(resolveProject(plain)).toEqual({ root: plain, name: 'notes' });
    expect(resolveProject('relative/dir')).toBeUndefined();
  });
});

describe('projectDisplayNames', () => {
  it('suffixes only roots that share a name', () => {
    const names = projectDisplayNames(['/a/clients/site', '/a/personal/site', '/a/Watermark']);
    expect(names.get('/a/clients/site')).toBe('site (clients)');
    expect(names.get('/a/personal/site')).toBe('site (personal)');
    expect(names.get('/a/Watermark')).toBe('Watermark');
  });
});
