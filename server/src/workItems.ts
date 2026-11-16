/**
 * What an agent is working through, from its own transcript: the latest
 * TodoWrite list, the last files it edited, and Claude's generated title for
 * the conversation. Claude only (Codex is observed as categories, by design).
 *
 * File paths, todo text and titles come from the user's own prompts and
 * work: tokened sockets only (usageLimits.ts PRIVILEGED_BROADCAST_TYPES).
 *
 * Idea adapted from The Lobby (github.com/Lilykos/orca-the-lobby, MIT).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentWorkItems, WorkTodo } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { CONTEXT_SEED_TAIL_BYTES } from './constants.js';
import type { AgentState } from './types.js';

/** Files kept per agent, newest first. */
export const WORK_FILES_MAX = 8;
/** Todos kept per agent, and the longest todo text sent. */
export const WORK_TODOS_MAX = 30;
const WORK_TEXT_MAX = 200;

const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

interface Items {
  todos: WorkTodo[];
  files: string[];
  title?: string;
  reply?: string;
}

/** Longest reply line sent for the office's speech bubble. */
export const WORK_REPLY_MAX = 120;

/** First non-empty line of a reply, without markdown emphasis, clipped. */
export function replyLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) =>
      l
        .replace(/^[#>*\-\s]+/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .find(Boolean);
  if (!line) return undefined;
  return line.length > WORK_REPLY_MAX ? `${line.slice(0, WORK_REPLY_MAX - 1)}…` : line;
}

const byStore = new WeakMap<AgentStateStore, Map<number, Items>>();

function itemsOf(store: AgentStateStore, id: number): Items {
  let m = byStore.get(store);
  if (!m) {
    byStore.set(store, (m = new Map()));
    store.on('agentRemoved', (gone) => m!.delete(gone));
  }
  let items = m.get(id);
  if (!items) m.set(id, (items = { todos: [], files: [] }));
  return items;
}

function clip(s: string): string {
  return s.length > WORK_TEXT_MAX ? `${s.slice(0, WORK_TEXT_MAX - 1)}…` : s;
}

/** A path as the panel shows it: relative to the project when inside it. */
export function displayPath(file: string, root: string | undefined): string {
  if (root && path.isAbsolute(file)) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return file;
}

function parseTodos(input: unknown): WorkTodo[] | undefined {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const out: WorkTodo[] = [];
  for (const t of todos.slice(0, WORK_TODOS_MAX)) {
    const text = typeof t?.content === 'string' ? t.content : undefined;
    if (!text) continue;
    const status =
      t.status === 'completed' || t.status === 'in_progress' ? t.status : ('pending' as const);
    out.push({ text: clip(text), status });
  }
  return out;
}

/**
 * Fold one transcript record into the agent's items. Returns true when they
 * changed. Sidechain records follow the context gauge's positional rule: once
 * the file has a main-chain turn, sidechain records are someone else's.
 */
export function reduceWorkItems(items: Items, agent: AgentState, record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, any>;
  if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle !== items.title) {
    items.title = clip(r.aiTitle);
    return true;
  }
  if (r.type !== 'assistant' || (r.isSidechain === true && agent.sawMainChainUsage)) return false;
  const content = r.message?.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && r.isSidechain !== true) {
      const line = replyLine(block.text);
      if (line && line !== items.reply) {
        items.reply = line;
        changed = true;
      }
      continue;
    }
    if (block?.type !== 'tool_use') continue;
    if (block.name === 'TodoWrite') {
      const todos = parseTodos(block.input);
      if (todos) {
        items.todos = todos;
        changed = true;
      }
      continue;
    }
    const key = EDIT_TOOLS[block.name as string];
    const file = key ? block.input?.[key] : undefined;
    if (typeof file !== 'string' || !file) continue;
    const shown = displayPath(file, agent.projectRoot);
    items.files = [shown, ...items.files.filter((f) => f !== shown)].slice(0, WORK_FILES_MAX);
    changed = true;
  }
  return changed;
}

export function workItemsMessage(id: number, items: Items): AgentWorkItems {
  return {
    type: 'agentWorkItems',
    id,
    todos: items.todos,
    files: items.files,
    ...(items.title ? { title: items.title } : {}),
    ...(items.reply ? { reply: items.reply } : {}),
  };
}

/** A transcript record arrived for this agent (transcriptParser). */
export function updateWorkItems(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
): void {
  const items = itemsOf(agents, agentId);
  if (reduceWorkItems(items, agent, record))
    agents.broadcast({ ...workItemsMessage(agentId, items) });
}

/**
 * Seed from the transcript's tail when watching starts, as the context gauge
 * does: an agent adopted mid-session otherwise shows nothing until its next
 * edit. Records are folded oldest first, so the newest list and files win.
 */
export function seedWorkItems(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent?.jsonlFile) return;
  let text: string;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    const start = Math.max(0, stat.size - CONTEXT_SEED_TAIL_BYTES);
    if (stat.size - start <= 0) return;
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return; // unreadable: the stream fills it on the next turn
  }
  const items = itemsOf(agents, agentId);
  let changed = false;
  for (const line of text.split('\n')) {
    if (!line || !/"(tool_use|ai-title|text)"/.test(line)) continue;
    try {
      if (reduceWorkItems(items, agent, JSON.parse(line))) changed = true;
    } catch {
      /* a malformed line must not stop the rest */
    }
  }
  if (changed) agents.broadcast({ ...workItemsMessage(agentId, items) });
}

/** Current items, for a (re)connecting privileged client. */
export function sendWorkItemsSnapshot(
  store: AgentStateStore,
  send: (message: Record<string, unknown>) => void,
): void {
  const m = byStore.get(store);
  if (!m) return;
  for (const [id, items] of m) {
    if (store.has(id) && (items.files.length || items.todos.length || items.title || items.reply)) {
      send({ ...workItemsMessage(id, items) });
    }
  }
}
