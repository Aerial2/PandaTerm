import { describe, expect, it } from 'vitest';
import { appendAiTree, aiTreeLeaves, aiTreePath, branchAiTree, migrateAiTree, switchAiTree } from './aiConversationTree';

type Message = { id: string; text: string };
const m = (id: string): Message => ({ id, text: id });

describe('AI conversation tree', () => {
  it('migrates legacy paths and preserves inactive siblings', () => {
    let tree = migrateAiTree([m('u1'), m('a1')]);
    tree = branchAiTree(tree, 'u1', [m('a2')]);
    expect(aiTreePath(tree)).toEqual([m('u1'), m('a2')]);
    expect(aiTreePath(tree, 'a1')).toEqual([m('u1'), m('a1')]);
    expect(aiTreeLeaves(tree).map(({ id }) => id).sort()).toEqual(['a1', 'a2']);
  });

  it('switches and appends without deleting branches', () => {
    const first = migrateAiTree([m('u1'), m('a1')]);
    const branched = appendAiTree(switchAiTree(first, 'u1'), [m('a2')]);
    expect(aiTreePath(branched)).toEqual([m('u1'), m('a2')]);
    expect(branched.nodes.map(({ id }) => id)).toEqual(['u1', 'a1', 'a2']);
  });

  it('rejects cycles, unknown leaves and duplicate IDs', () => {
    expect(() => aiTreePath({ nodes: [{ id: 'a', parent_id: 'a', message: m('a') }], active_leaf_id: 'a' })).toThrow();
    expect(() => switchAiTree(migrateAiTree([m('a')]), 'unknown')).toThrow();
    expect(() => appendAiTree(migrateAiTree([m('a')]), [m('a')])).toThrow();
  });
});