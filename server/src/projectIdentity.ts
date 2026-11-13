/**
 * Which project a working directory belongs to. Project metadata is kept apart
 * from agent identity: a session moving between projects changes its label,
 * never which character it is.
 *
 * - Subdirectories belong to the nearest enclosing git root.
 * - Symlinked paths resolve to their real location first.
 * - A linked worktree (`.git` file -> `<repo>/.git/worktrees/<name>`, with a
 *   `commondir`) groups with its main repository; the worktree is kept as detail.
 * - Anything else with a `.git` file (a submodule, an unreadable marker) is its
 *   own project.
 * - Without a git root the directory's own basename is used.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectIdentity {
  /** Canonical root: the main repository for worktrees. */
  root: string;
  /** Basename of the root (before same-name disambiguation). */
  name: string;
  /** The linked worktree's directory name, when the cwd is in one. */
  worktree?: string;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(p);
  }
}

/** Main repository root for a linked worktree's `.git` file, else undefined. */
function worktreeMainRoot(dir: string, gitFile: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!match) return undefined;
    const gitDir = path.resolve(dir, match[1].trim());
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    const mainGitDir = realPath(path.resolve(gitDir, commonDir));
    return path.basename(mainGitDir) === '.git' ? path.dirname(mainGitDir) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveProject(cwd: string): ProjectIdentity | undefined {
  if (!path.isAbsolute(cwd)) return undefined;
  const start = realPath(cwd);
  let dir = start;
  while (true) {
    const marker = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(marker);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return { root: dir, name: path.basename(dir) || dir };
    if (stat?.isFile()) {
      const main = worktreeMainRoot(dir, marker);
      if (main)
        return { root: main, name: path.basename(main) || main, worktree: path.basename(dir) };
      return { root: dir, name: path.basename(dir) || dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { root: start, name: path.basename(start) || start };
    dir = parent;
  }
}

/**
 * Display names for a set of live project roots: a unique basename is used as
 * is; roots sharing a basename get their parent folder appended, e.g.
 * `site (clients)` and `site (personal)`.
 */
export function projectDisplayNames(roots: Iterable<string>): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const root of roots) {
    const name = path.basename(root) || root;
    const set = byName.get(name) ?? new Set<string>();
    set.add(root);
    byName.set(name, set);
  }
  const result = new Map<string, string>();
  for (const [name, set] of byName) {
    for (const root of set) {
      const parent = path.basename(path.dirname(root));
      result.set(root, set.size > 1 && parent ? `${name} (${parent})` : name);
    }
  }
  return result;
}
