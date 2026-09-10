import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import {
  activateTerminalPaneTab,
  addTerminalTabToPane,
  collectTerminalLayoutTabIds,
  createDefaultTerminalLayout,
  findLeafTabGroup,
  findTerminalWorkspaceOwner,
  insertTerminalPane,
  removeTerminalTabFromPane,
  reorderPaneTabIds,
  type TerminalLayoutNode,
  type WorkspaceTab,
} from './terminalLayout';

function createSession(id: string, protocol: 'ssh' | 'rdp' = 'ssh'): Session {
  return {
    id,
    name: id,
    group: 'test',
    protocol,
    host: '127.0.0.1',
    port: protocol === 'rdp' ? 3389 : 22,
    username: 'tester',
    auth: { type: 'agent' },
    tags: [],
    reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
  };
}

function createWorkspaceTab(
  id: string,
  kind: 'terminal' | 'rdp',
  layout: TerminalLayoutNode,
  parentTabId?: string,
): WorkspaceTab {
  return {
    id,
    kind,
    session: createSession(id, kind === 'rdp' ? 'rdp' : 'ssh'),
    title: id,
    terminalId: `terminal:${id}`,
    status: 'connected',
    output: [],
    closedByUser: false,
    reconnectAttempts: 0,
    activityLog: [],
    layout,
    activePaneId: id,
    parentTabId,
  };
}

const splitLayout: TerminalLayoutNode = {
  type: 'split',
  id: 'split:root',
  direction: 'horizontal',
  ratio: 0.5,
  first: { type: 'leaf', tabId: 'ssh-1', tabIds: ['ssh-1', 'rdp-1'] },
  second: { type: 'leaf', tabId: 'ssh-2', tabIds: ['ssh-2'] },
};

describe('terminal pane tab groups', () => {
  it('finds only the leaf group containing the requested tab', () => {
    expect(findLeafTabGroup(splitLayout, 'rdp-1')).toEqual(['ssh-1', 'rdp-1']);
    expect(findLeafTabGroup(splitLayout, 'ssh-2')).toEqual(['ssh-2']);
    expect(findLeafTabGroup(splitLayout, 'missing')).toEqual([]);
    expect(findLeafTabGroup(undefined, 'ssh-1')).toEqual([]);
  });

  it('reorders tabs only inside the requested leaf', () => {
    const reordered = reorderPaneTabIds(splitLayout, 'ssh-1', 'rdp-1', 'ssh-1', 'before');

    expect(findLeafTabGroup(reordered, 'ssh-1')).toEqual(['rdp-1', 'ssh-1']);
    expect(findLeafTabGroup(reordered, 'ssh-2')).toEqual(['ssh-2']);
    expect(collectTerminalLayoutTabIds(reordered)).toEqual(['rdp-1', 'ssh-1', 'ssh-2']);
  });

  it('splits only the dragged tab and keeps sibling tabs in their original panes', () => {
    const split = insertTerminalPane(splitLayout, 'ssh-1', 'rdp-1', 'right');

    expect(findLeafTabGroup(split, 'ssh-1')).toEqual(['ssh-1']);
    expect(findLeafTabGroup(split, 'rdp-1')).toEqual(['rdp-1']);
    expect(findLeafTabGroup(split, 'ssh-2')).toEqual(['ssh-2']);
    expect(collectTerminalLayoutTabIds(split)).toEqual(['ssh-1', 'rdp-1', 'ssh-2']);
  });

  it('keeps the active tab and tab list consistent when activating and removing', () => {
    const activated = activateTerminalPaneTab(splitLayout, 'rdp-1');
    const result = removeTerminalTabFromPane(activated, 'rdp-1');

    expect(result.nextActivePaneId).toBe('ssh-1');
    expect(findLeafTabGroup(result.layout ?? undefined, 'ssh-1')).toEqual(['ssh-1']);
    expect(collectTerminalLayoutTabIds(result.layout ?? undefined)).toEqual(['ssh-1', 'ssh-2']);
  });

  it('adds a mixed-kind tab once without duplicating it', () => {
    const base = createDefaultTerminalLayout('rdp-root');
    const added = addTerminalTabToPane(base, 'rdp-root', 'ssh-child');
    const duplicate = addTerminalTabToPane(added, 'rdp-root', 'ssh-child');

    expect(findLeafTabGroup(duplicate, 'ssh-child')).toEqual(['rdp-root', 'ssh-child']);
    expect(collectTerminalLayoutTabIds(duplicate)).toEqual(['rdp-root', 'ssh-child']);
  });
});

describe('findTerminalWorkspaceOwner', () => {
  it('recognizes both terminal and RDP root workspaces', () => {
    const terminalRoot = createWorkspaceTab('terminal-root', 'terminal', createDefaultTerminalLayout('terminal-root'));
    const rdpLayout = addTerminalTabToPane(createDefaultTerminalLayout('rdp-root'), 'rdp-root', 'ssh-child');
    const rdpRoot = createWorkspaceTab('rdp-root', 'rdp', rdpLayout);
    const sshChild = createWorkspaceTab('ssh-child', 'terminal', createDefaultTerminalLayout('ssh-child'), 'rdp-root');
    const tabs = [terminalRoot, rdpRoot, sshChild];

    expect(findTerminalWorkspaceOwner(tabs, 'terminal-root')?.id).toBe('terminal-root');
    expect(findTerminalWorkspaceOwner(tabs, 'rdp-root')?.id).toBe('rdp-root');
    expect(findTerminalWorkspaceOwner(tabs, 'ssh-child')?.id).toBe('rdp-root');
    expect(findTerminalWorkspaceOwner(tabs, 'missing')).toBeNull();
  });
});
