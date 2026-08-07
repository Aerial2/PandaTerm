/**
 * 终端分屏布局树 — 纯函数（无 React / DOM）。
 * 从 App.tsx 拆出，职责：layout 变换与查找。
 */
import type { Session } from './api';

export type TabKind = 'terminal' | 'sftp' | 'rdp';

export type TerminalStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disconnected'
  | 'closed';

export type TerminalSplitDirection = 'horizontal' | 'vertical';
export type TerminalDropSide = 'left' | 'right' | 'top' | 'bottom';
export type TerminalDragOperation = 'none' | 'reorder' | 'split' | 'replace' | 'workspace';
export type TerminalReorderPlacement = 'before' | 'after';

export type TerminalDragState = {
  tabId: string;
  operation: TerminalDragOperation;
  isOverWorkspace: boolean;
  targetPaneId: string | null;
  targetTabId: string | null;
  targetRegion: 'pane' | 'tabbar' | null;
  side: TerminalDropSide | null;
  reorderPlacement: TerminalReorderPlacement | null;
  ghostX: number;
  ghostY: number;
};

export type TerminalPointerDragCandidate = {
  tabId: string;
  startX: number;
  startY: number;
  active: boolean;
  previousActiveTabId: string | null;
};

export type TerminalSplitResizeCandidate = {
  splitId: string;
  direction: TerminalSplitDirection;
  startX: number;
  startY: number;
  startRatio: number;
  containerWidth: number;
  containerHeight: number;
};

export type TerminalLayoutNode =
  | { type: 'leaf'; tabId: string; tabIds?: string[] }
  | {
      type: 'split';
      id: string;
      direction: TerminalSplitDirection;
      ratio: number;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

export type TerminalActivityEntry = {
  time: string;
  level: 'info' | 'warn' | 'error';
  text: string;
};

export type WorkspaceTab = {
  id: string;
  kind: TabKind;
  session: Session;
  title: string;
  terminalId: string;
  status: TerminalStatus;
  output: string[];
  statusMessage?: string;
  closedByUser: boolean;
  reconnectAttempts: number;
  activityLog: TerminalActivityEntry[];
  layout?: TerminalLayoutNode;
  activePaneId?: string;
  parentTabId?: string;
};

export type TerminalSizeSnapshot = {
  width: number;
  height: number;
  cols: number;
  rows: number;
};

export const TERMINAL_TAB_DRAG_THRESHOLD = 12;
export const TERMINAL_PANE_EDGE_DROP_RATIO = 0.25;
export const TERMINAL_SPLIT_RATIO_MIN = 0.15;
export const TERMINAL_SPLIT_RATIO_MAX = 0.85;

export function createDefaultTerminalLayout(tabId: string): TerminalLayoutNode {
  return { type: 'leaf', tabId, tabIds: [tabId] };
}

export function getLeafTabIds(node: Extract<TerminalLayoutNode, { type: 'leaf' }>): string[] {
  return node.tabIds?.length ? node.tabIds : [node.tabId];
}

export function collectTerminalLayoutTabIds(node?: TerminalLayoutNode): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return getLeafTabIds(node);
  return [...collectTerminalLayoutTabIds(node.first), ...collectTerminalLayoutTabIds(node.second)];
}

/// 返回 paneTabId 所在 leaf 的整个 tab 组（含同 pane 内的多个 tab）。
/// 顶层栏「就地展开当前激活 pane 的 tab 组」用此定位，找不到返回空数组。
export function findLeafTabGroup(node: TerminalLayoutNode | undefined, paneTabId: string): string[] {
  if (!node) return [];
  if (node.type === 'leaf') {
    const ids = getLeafTabIds(node);
    return ids.includes(paneTabId) ? ids : [];
  }
  const inFirst = findLeafTabGroup(node.first, paneTabId);
  return inFirst.length ? inFirst : findLeafTabGroup(node.second, paneTabId);
}

export function terminalLayoutContainsSplit(node: TerminalLayoutNode, splitId: string): boolean {
  if (node.type === 'leaf') return false;
  return (
    node.id === splitId
    || terminalLayoutContainsSplit(node.first, splitId)
    || terminalLayoutContainsSplit(node.second, splitId)
  );
}

export function clampSplitRatio(value: number) {
  return Math.min(TERMINAL_SPLIT_RATIO_MAX, Math.max(TERMINAL_SPLIT_RATIO_MIN, value));
}

export function updateTerminalSplitRatio(
  node: TerminalLayoutNode,
  splitId: string,
  ratio: number,
): TerminalLayoutNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, ratio: clampSplitRatio(ratio) };
  return {
    ...node,
    first: updateTerminalSplitRatio(node.first, splitId, ratio),
    second: updateTerminalSplitRatio(node.second, splitId, ratio),
  };
}

export function dropSideToSplit(side: TerminalDropSide) {
  return {
    direction: side === 'left' || side === 'right' ? ('horizontal' as const) : ('vertical' as const),
    placeBefore: side === 'left' || side === 'top',
  };
}

export function insertTerminalPane(
  node: TerminalLayoutNode,
  targetTabId: string,
  droppedTabId: string,
  side: TerminalDropSide,
): TerminalLayoutNode {
  // 先剥离 droppedTabId，避免一 tab 挂到两片 leaf
  const base = removeTerminalPane(node, droppedTabId);
  const root: TerminalLayoutNode = base ?? { type: 'leaf', tabId: targetTabId, tabIds: [targetTabId] };
  return insertTerminalPaneLeaf(root, targetTabId, droppedTabId, side);
}

export function removeTerminalPane(node: TerminalLayoutNode, targetTabId: string): TerminalLayoutNode | null {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(targetTabId)) return node;
    const remaining = tabIds.filter((id) => id !== targetTabId);
    if (remaining.length === 0) return null;
    const nextActive = node.tabId === targetTabId ? remaining[0] : node.tabId;
    return { ...node, tabId: nextActive, tabIds: remaining };
  }

  const first = removeTerminalPane(node.first, targetTabId);
  const second = removeTerminalPane(node.second, targetTabId);

  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function insertTerminalPaneLeaf(
  node: TerminalLayoutNode,
  targetTabId: string,
  droppedTabId: string,
  side: TerminalDropSide,
): TerminalLayoutNode {
  if (node.type === 'leaf') {
    if (!getLeafTabIds(node).includes(targetTabId)) return node;
    const { direction, placeBefore } = dropSideToSplit(side);
    const droppedLeaf: TerminalLayoutNode = { type: 'leaf', tabId: droppedTabId, tabIds: [droppedTabId] };
    const targetLeaf: TerminalLayoutNode = { ...node };
    return {
      type: 'split',
      id: `split:${crypto.randomUUID()}`,
      direction,
      ratio: 0.5,
      first: placeBefore ? droppedLeaf : targetLeaf,
      second: placeBefore ? targetLeaf : droppedLeaf,
    };
  }

  return {
    ...node,
    first: insertTerminalPaneLeaf(node.first, targetTabId, droppedTabId, side),
    second: insertTerminalPaneLeaf(node.second, targetTabId, droppedTabId, side),
  };
}

export function addTerminalTabToPane(
  node: TerminalLayoutNode,
  paneTabId: string,
  nextTabId: string,
): TerminalLayoutNode {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(paneTabId)) return node;
    if (tabIds.includes(nextTabId)) return node;
    return { ...node, tabId: nextTabId, tabIds: [...tabIds, nextTabId] };
  }

  return {
    ...node,
    first: addTerminalTabToPane(node.first, paneTabId, nextTabId),
    second: addTerminalTabToPane(node.second, paneTabId, nextTabId),
  };
}

export function reorderPaneTabIds(
  node: TerminalLayoutNode,
  paneId: string,
  sourceTabId: string,
  targetTabId: string,
  placement: 'before' | 'after',
): TerminalLayoutNode {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(paneId) && node.tabId !== paneId) return node;
    if (!tabIds.includes(sourceTabId) || !tabIds.includes(targetTabId)) return node;
    const without = tabIds.filter((id) => id !== sourceTabId);
    const targetIdx = without.indexOf(targetTabId);
    if (targetIdx < 0) return node;
    const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1;
    const next = [...without];
    next.splice(insertIdx, 0, sourceTabId);
    return { ...node, tabIds: next };
  }
  return {
    ...node,
    first: reorderPaneTabIds(node.first, paneId, sourceTabId, targetTabId, placement),
    second: reorderPaneTabIds(node.second, paneId, sourceTabId, targetTabId, placement),
  };
}

export function activateTerminalPaneTab(node: TerminalLayoutNode, paneTabId: string): TerminalLayoutNode {
  if (node.type === 'leaf') {
    return getLeafTabIds(node).includes(paneTabId) ? { ...node, tabId: paneTabId } : node;
  }

  return {
    ...node,
    first: activateTerminalPaneTab(node.first, paneTabId),
    second: activateTerminalPaneTab(node.second, paneTabId),
  };
}

export function removeTerminalTabFromPane(
  node: TerminalLayoutNode,
  paneTabId: string,
): { layout: TerminalLayoutNode | null; nextActivePaneId: string | null } {
  if (node.type === 'leaf') {
    const nextTabIds = getLeafTabIds(node).filter((tabId) => tabId !== paneTabId);
    if (nextTabIds.length === 0) return { layout: null, nextActivePaneId: null };
    const nextActivePaneId = node.tabId === paneTabId ? nextTabIds[0] : node.tabId;
    return { layout: { ...node, tabId: nextActivePaneId, tabIds: nextTabIds }, nextActivePaneId };
  }

  const first = removeTerminalTabFromPane(node.first, paneTabId);
  const second = removeTerminalTabFromPane(node.second, paneTabId);

  if (!first.layout) return { layout: second.layout, nextActivePaneId: second.nextActivePaneId };
  if (!second.layout) return { layout: first.layout, nextActivePaneId: first.nextActivePaneId };
  return {
    layout: { ...node, first: first.layout, second: second.layout },
    nextActivePaneId: first.nextActivePaneId ?? second.nextActivePaneId,
  };
}

export function findTerminalWorkspaceOwner(tabs: WorkspaceTab[], paneTabId: string): WorkspaceTab | null {
  return (
    tabs.find(
      (tab) =>
        (tab.kind === 'terminal' || tab.kind === 'rdp')
        && !tab.parentTabId
        && collectTerminalLayoutTabIds(tab.layout ?? createDefaultTerminalLayout(tab.id)).includes(paneTabId),
    ) ?? null
  );
}