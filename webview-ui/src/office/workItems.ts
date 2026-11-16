/**
 * Per agent, from the server (tokened pages only): its latest todo list, the
 * files it edited last, Claude's title for the conversation
 * (agentWorkItems), and its project's uncommitted changes
 * (workingTreeChanges). A read-only page never receives either.
 */
import type {
  AgentTreeChanges,
  AgentWorkItems,
  WorkingTreeChanges,
} from '../../../core/src/messages.js';

const items = new Map<number, AgentWorkItems>();
let tree = new Map<number, AgentTreeChanges>();

export function setWorkItems(message: AgentWorkItems): void {
  items.set(message.id, message);
}

export function getWorkItems(id: number): AgentWorkItems | undefined {
  return items.get(id);
}

export function setTreeChanges(message: WorkingTreeChanges): void {
  tree = new Map(message.agents.map((a) => [a.id, a]));
}

export function getTreeChanges(id: number): AgentTreeChanges | undefined {
  return tree.get(id);
}

export function clearWorkItems(id: number): void {
  items.delete(id);
  tree.delete(id);
}

/** "3 files · +10 −2", or "No uncommitted changes". */
export function treeChangesText(c: AgentTreeChanges): string {
  if (c.files === 0) return 'No uncommitted changes';
  return `${c.files} ${c.files === 1 ? 'file' : 'files'} · +${c.insertions} −${c.deletions}`;
}
