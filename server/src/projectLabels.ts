/**
 * Pinned project display names (e.g. "MarketingSite" -> "Website"), keyed by
 * the project's canonical root. Set from a tokened client; applied by the
 * label refresher, so every viewer sees the same names. Stored privately in
 * ~/.pixel-agents/project-labels.json.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PIXEL_AGENTS_DIR } from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';

/** Longest pinned project name. */
export const PROJECT_LABEL_MAX_LENGTH = 40;

const FILE_NAME = 'project-labels.json';

function filePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, FILE_NAME);
}

let cache: Record<string, string> | undefined;

export function readProjectLabels(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0,
            ),
          )
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Pin (or, with an empty label, unpin) the display name of a project root. */
export function setProjectLabel(root: string, label: string): void {
  const value = label.trim().slice(0, PROJECT_LABEL_MAX_LENGTH);
  const next = { ...readProjectLabels() };
  if (value) next[root] = value;
  else delete next[root];
  cache = next;
  writeJsonAtomic(filePath(), next);
}

/** Tests only. */
export function resetProjectLabelCache(): void {
  cache = undefined;
}
