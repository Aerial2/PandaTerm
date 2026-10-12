export type AiTree<M extends { id: string }> = {
  nodes: Array<{ id: string; parent_id: string | null; message: M }>;
  active_leaf_id: string | null;
};

/** Legacy linear history is migrated once; existing off-path nodes are retained. */
export function migrateAiTree<M extends { id: string }>(messages: M[], tree?: AiTree<M>): AiTree<M> {
  return syncAiTree(tree ?? { nodes: [], active_leaf_id: null }, messages);
}

/** Upsert an active path without removing siblings, including changed action state. */
export function syncAiTree<M extends { id: string }>(tree: AiTree<M>, messages: M[]): AiTree<M> {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let parent: string | null = null;
  for (const message of messages) {
    if (!message.id || seen.has(message.id)) throw new Error('会话消息 ID 必须唯一且非空');
    seen.add(message.id);
    const existing = nodes.get(message.id);
    if (existing && existing.parent_id !== parent) throw new Error('建立分支时必须为修改的消息生成新 ID');
    nodes.set(message.id, { id: message.id, parent_id: parent, message });
    parent = message.id;
  }
  return { nodes: [...nodes.values()], active_leaf_id: parent };
}

export function aiTreePath<M extends { id: string }>(tree: AiTree<M>, leaf = tree.active_leaf_id): M[] {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const path: M[] = [];
  while (leaf !== null) {
    if (seen.has(leaf)) throw new Error('会话树包含循环');
    const node = nodes.get(leaf);
    if (!node) throw new Error('会话树引用了不存在的消息');
    seen.add(leaf);
    path.unshift(node.message);
    leaf = node.parent_id;
  }
  return path;
}

export function switchAiTree<M extends { id: string }>(tree: AiTree<M>, leaf: string | null): AiTree<M> {
  aiTreePath(tree, leaf);
  return { ...tree, active_leaf_id: leaf };
}

export function appendAiTree<M extends { id: string }>(tree: AiTree<M>, messages: M[]): AiTree<M> {
  return syncAiTree(tree, [...aiTreePath(tree), ...messages]);
}

export function branchAiTree<M extends { id: string }>(tree: AiTree<M>, parent: string | null, messages: M[] = []): AiTree<M> {
  return appendAiTree(switchAiTree(tree, parent), messages);
}

export function aiTreeLeaves<M extends { id: string }>(tree: AiTree<M>): M[] {
  const parents = new Set(tree.nodes.map((node) => node.parent_id));
  return tree.nodes.filter((node) => !parents.has(node.id)).map((node) => node.message);
}