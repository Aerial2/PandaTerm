import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceFile } from './resourceModel';
import type { WorkspaceTab } from './terminalLayout';
import type { MediaKind } from './useMediaViewer';

// Node-only hook harness: retain state/ref slots across explicit renders.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (value: unknown) => {
      hooks.slots[slot] = typeof value === 'function' ? value(hooks.slots[slot]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot];
  },
}));
vi.mock('./api', () => ({ readFileAsDataUrl: vi.fn() }));
vi.mock('./appShellStore', () => ({ setStatusMessage: vi.fn() }));

import { readFileAsDataUrl } from './api';
import { setStatusMessage } from './appShellStore';
import { useMediaViewer } from './useMediaViewer';

const file: ResourceFile = {
  name: 'photo.png', path: '/srv/photo.png', type: 'file',
  size: '1 KB', sizeBytes: 1024, modifiedTime: '',
};
const url = 'data:image/png;base64,cGhvdG8=';
const remoteTab = (): WorkspaceTab => ({
  id: 'pane-a', kind: 'terminal', title: 'Production', terminalId: 'terminal-a',
  status: 'connected', output: [], closedByUser: false, reconnectAttempts: 0, activityLog: [],
  session: {
    id: 'production', name: 'Production', group: '', protocol: 'ssh',
    host: 'host.example', port: 22, username: 'alice', auth: { type: 'agent' }, tags: [],
    reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  const tab = remoteTab();
  const activePaneTabRef = { current: tab as WorkspaceTab | null };
  const onOpened = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    return useMediaViewer({
      activePaneTabRef,
      isLocalResourceTab: (current) => !current || current.session.id === 'local',
      onOpened,
    });
  };
  return { tab, activePaneTabRef, onOpened, render, viewer: render() };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  vi.mocked(readFileAsDataUrl).mockReset();
  vi.mocked(setStatusMessage).mockReset();
});

describe('useMediaViewer successful open recording', () => {
  it.each(['image', 'video', 'audio'] as const)('records a current remote %s only after its read succeeds', async (kind: MediaKind) => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, onOpened, tab } = setup();

    const opening = viewer.openMediaViewer(file, kind);
    expect(readFileAsDataUrl).toHaveBeenCalledExactlyOnceWith(file.path, tab.terminalId);
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();

    read.resolve(url);
    await opening;
    expect(render()).toMatchObject({
      mediaViewer: { url, name: file.name, kind }, isLoadingMedia: false, mediaError: '',
    });
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(file, kind, {
      paneId: tab.id, terminalId: tab.terminalId, session: tab.session,
    });
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith(`正在查看：${file.name}`);
  });
});

describe('useMediaViewer explicit and disconnected targets', () => {
  it('reads an explicit local target with a null terminal and session', async () => {
    vi.mocked(readFileAsDataUrl).mockResolvedValue(url);
    const { viewer, render, activePaneTabRef, onOpened, tab } = setup();
    activePaneTabRef.current = { ...tab, session: { ...tab.session, id: 'local' } };
    const target = { paneId: tab.id, terminalId: null, session: null };

    await viewer.openMediaViewer(file, 'image', target);

    expect(readFileAsDataUrl).toHaveBeenCalledExactlyOnceWith(file.path, null);
    expect(render()).toMatchObject({
      mediaViewer: { url, name: file.name, kind: 'image' }, isLoadingMedia: false, mediaError: '',
    });
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(file, 'image', target);
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith(`正在查看：${file.name}`);
  });

  it('never falls back to a local read for a disconnected remote without a terminal ID', async () => {
    const { viewer, render, activePaneTabRef, onOpened, tab } = setup();
    activePaneTabRef.current = { ...tab, terminalId: '', status: 'disconnected' };

    await viewer.openMediaViewer(file, 'image');

    expect(readFileAsDataUrl).not.toHaveBeenCalled();
    expect(render()).toMatchObject({
      mediaViewer: null, isLoadingMedia: false, mediaError: '远程终端尚未连接，无法查看媒体文件',
    });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith('远程终端尚未连接，无法查看媒体文件');
  });
});

describe('useMediaViewer failed reads', () => {
  it.each([new Error('permission denied'), 'permission denied'])('does not record a failed read (%s)', async (error) => {
    vi.mocked(readFileAsDataUrl).mockRejectedValue(error);
    const { viewer, render, onOpened } = setup();

    await viewer.openMediaViewer(file, 'image');
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: 'permission denied' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith('无法查看媒体文件：permission denied');
  });

  it('clears a previous error and records a successful retry', async () => {
    vi.mocked(readFileAsDataUrl).mockRejectedValueOnce(new Error('read failed'));
    const { viewer, render, onOpened } = setup();
    await viewer.openMediaViewer(file, 'image');
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValueOnce(read.promise);

    const opening = render().openMediaViewer(file, 'image');
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    read.resolve(url);
    await opening;
    expect(render()).toMatchObject({ mediaViewer: { url, name: file.name, kind: 'image' }, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });
});

describe('useMediaViewer stale target handling', () => {
  const switches: Array<[string, (tab: WorkspaceTab) => WorkspaceTab | null]> = [
    ['another pane', (tab) => ({ ...tab, id: 'pane-b' })],
    ['a reconnected terminal in the same pane', (tab) => ({ ...tab, terminalId: 'terminal-b' })],
    ['a local resource tab', (tab) => ({ ...tab, session: { ...tab.session, id: 'local' } })],
    ['no active pane', () => null],
    ['a disconnected terminal', (tab) => ({ ...tab, status: 'disconnected' })],
  ];

  it.each(switches)('does not record a successful read after switching to %s', async (_name, switchTab) => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, activePaneTabRef, onOpened, tab } = setup();
    const opening = viewer.openMediaViewer(file, 'image');

    activePaneTabRef.current = switchTab(tab);
    read.resolve(url);
    await opening;
    expect(render()).toMatchObject({ mediaViewer: null, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
  });

  it('keeps a newer valid read pending when an explicit stale target is requested', async () => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, activePaneTabRef, onOpened, tab } = setup();
    const staleTarget = { paneId: tab.id, terminalId: tab.terminalId, session: tab.session };
    const currentTab = { ...tab, id: 'pane-b', terminalId: 'terminal-b' };
    activePaneTabRef.current = currentTab;
    const nextFile = { ...file, name: 'next.png', path: '/srv/next.png' };
    const opening = viewer.openMediaViewer(nextFile, 'image');
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });

    await render().openMediaViewer(file, 'image', staleTarget);

    expect(readFileAsDataUrl).toHaveBeenCalledExactlyOnceWith(nextFile.path, currentTab.terminalId);
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();

    read.resolve(url);
    await opening;
    expect(render()).toMatchObject({
      mediaViewer: { url, name: nextFile.name, kind: 'image' }, isLoadingMedia: false, mediaError: '',
    });
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(nextFile, 'image', {
      paneId: currentTab.id, terminalId: currentTab.terminalId, session: currentTab.session,
    });
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith(`正在查看：${nextFile.name}`);
  });

  it('ignores a failure from the previous pane', async () => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, activePaneTabRef, onOpened, tab } = setup();
    const opening = viewer.openMediaViewer(file, 'image');

    activePaneTabRef.current = { ...tab, id: 'pane-b' };
    read.reject(new Error('old pane failed'));
    await opening;
    expect(render()).toMatchObject({ mediaViewer: null, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('keeps the newer request loading when a superseded read ends with %s', async (outcome) => {
    const oldRead = deferred<string>();
    const currentRead = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
    const { viewer, render, onOpened } = setup();
    const nextFile = { ...file, name: 'next.png', path: '/srv/next.png' };
    const oldOpening = viewer.openMediaViewer(file, 'image');
    const currentOpening = render().openMediaViewer(nextFile, 'image');

    if (outcome === 'success') oldRead.resolve('data:old');
    else oldRead.reject(new Error('old read failed'));
    await oldOpening;
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();

    currentRead.resolve(url);
    await currentOpening;
    expect(render()).toMatchObject({ mediaViewer: { url, name: nextFile.name, kind: 'image' }, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onOpened.mock.calls[0][0]).toBe(nextFile);
  });

  it('preserves a newer preview when an older read succeeds last', async () => {
    const oldRead = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(url);
    const { viewer, render, onOpened } = setup();
    const nextFile = { ...file, name: 'next.png', path: '/srv/next.png' };
    const oldOpening = viewer.openMediaViewer(file, 'image');
    await render().openMediaViewer(nextFile, 'image');

    oldRead.resolve('data:old');
    await oldOpening;
    expect(render()).toMatchObject({ mediaViewer: { url, name: nextFile.name, kind: 'image' }, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(onOpened.mock.calls[0][0]).toBe(nextFile);
    expect(setStatusMessage).toHaveBeenCalledExactlyOnceWith(`正在查看：${nextFile.name}`);
  });
});

describe('useMediaViewer close handling', () => {
  it.each(['success', 'failure'] as const)('does not publish or record a pending read that ends with %s after closing', async (outcome) => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, onOpened } = setup();
    const opening = viewer.openMediaViewer(file, 'image');
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: true, mediaError: '' });

    render().closeMediaViewer();
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: '' });

    if (outcome === 'success') read.resolve(url);
    else read.reject(new Error('read failed after close'));
    await opening;

    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
  });
});

describe('useMediaViewer reset handling', () => {
  it.each(['success', 'failure'] as const)('invalidates an in-flight read that ends with %s', async (outcome) => {
    const read = deferred<string>();
    vi.mocked(readFileAsDataUrl).mockReturnValue(read.promise);
    const { viewer, render, onOpened } = setup();
    const opening = viewer.openMediaViewer(file, 'image');

    render().resetMediaViewer();
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: '' });
    if (outcome === 'success') read.resolve(url);
    else read.reject(new Error('read failed after reset'));
    await opening;
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
  });

  it('clears an existing preview without recording another open', async () => {
    vi.mocked(readFileAsDataUrl).mockResolvedValue(url);
    const { viewer, render, onOpened } = setup();
    await viewer.openMediaViewer(file, 'image');
    onOpened.mockClear();
    vi.mocked(setStatusMessage).mockClear();

    render().resetMediaViewer();
    expect(render()).toMatchObject({ mediaViewer: null, isLoadingMedia: false, mediaError: '' });
    expect(onOpened).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
  });
});
