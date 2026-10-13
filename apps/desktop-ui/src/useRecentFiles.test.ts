import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise async hook behavior in the project's Node test environment without a DOM dependency.
const lifecycle = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effect: null as (() => void | (() => void)) | null,
  updates: 0,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = lifecycle.cursor++;
    if (!(index in lifecycle.slots)) lifecycle.slots[index] = initial;
    return [lifecycle.slots[index], (value: unknown) => {
      lifecycle.updates++;
      lifecycle.slots[index] = value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = lifecycle.cursor++;
    if (!(index in lifecycle.slots)) lifecycle.slots[index] = { current: initial };
    return lifecycle.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { lifecycle.effect = effect; },
}));
vi.mock('./api', () => ({
  listRecentFiles: vi.fn(), listSessions: vi.fn(), upsertRecentFile: vi.fn(),
  removeRecentFile: vi.fn(), clearRecentFiles: vi.fn(),
}));

import * as api from './api';
import { useRecentFiles } from './useRecentFiles';

const file: api.RecentFile = {
  session_id: 'prod', protocol: 'ssh', host: 'host.example', port: 22,
  username: 'alice', path: '/srv/main.rs', name: 'main.rs', kind: 'file',
  opened_at: '2026-10-12T12:00:00Z',
};
function sessions(...ids: string[]): api.Session[] {
  return ids.map((id) => ({
    id, name: id, group: '', host: 'host.example', port: 22, username: 'alice',
    auth: { type: 'agent' }, tags: [], reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function render() {
  lifecycle.cursor = 0;
  return useRecentFiles();
}
function mount() {
  const hook = render();
  const cleanup = lifecycle.effect?.();
  return { hook, unmount: () => { if (cleanup) cleanup(); } };
}

beforeEach(() => {
  vi.resetAllMocks();
  lifecycle.slots = [];
  lifecycle.cursor = 0;
  lifecycle.updates = 0;
  lifecycle.effect = null;
  vi.mocked(api.listRecentFiles).mockResolvedValue([file]);
  vi.mocked(api.listSessions).mockResolvedValue(sessions('prod'));
  vi.mocked(api.upsertRecentFile).mockResolvedValue([file]);
  vi.mocked(api.removeRecentFile).mockResolvedValue([]);
  vi.mocked(api.clearRecentFiles).mockResolvedValue([]);
});

describe('useRecentFiles', () => {
  it('loads records and sessions on mount and retains query state', async () => {
    const { hook } = mount();
    expect(hook.currentSessionIds).toBeNull();
    expect(hook.loading).toBe(true);
    // A queued refresh also provides a completion barrier for the mount load.
    await hook.refreshSessions();
    hook.setQuery('main');
    expect(render()).toMatchObject({ records: [file], currentSessionIds: ['prod'], loading: false, error: null, query: 'main' });
    expect(api.listRecentFiles).toHaveBeenCalledTimes(1);
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it('waits for the initial list before applying mutations in invocation order', async () => {
    const initial = deferred<api.RecentFile[]>();
    const removed = deferred<api.RecentFile[]>();
    vi.mocked(api.listRecentFiles).mockReturnValue(initial.promise);
    vi.mocked(api.removeRecentFile).mockReturnValue(removed.promise);
    const { hook } = mount();
    const removal = hook.remove(file);
    const clear = hook.clear([file]);
    await Promise.resolve();
    expect(api.removeRecentFile).not.toHaveBeenCalled();
    initial.resolve([file]);
    await vi.waitFor(() => expect(api.removeRecentFile).toHaveBeenCalledWith(file));
    expect(api.clearRecentFiles).not.toHaveBeenCalled();
    removed.resolve([file]);
    await Promise.all([removal, clear]);
    expect(api.clearRecentFiles).toHaveBeenCalledWith([file]);
    expect(render().records).toEqual([]);
  });

  it('fetches fresh session IDs before each upsert', async () => {
    const { hook } = mount();
    await hook.refreshSessions();
    vi.mocked(api.listSessions).mockResolvedValue(sessions('new-session'));
    await hook.recordOpen(file);
    expect(api.upsertRecentFile).toHaveBeenCalledWith(file, ['new-session']);
    expect(render().currentSessionIds).toEqual(['new-session']);
  });

  it('shows session errors, skips unsafe upserts, and recovers the queue', async () => {
    const { hook } = mount();
    await hook.refreshSessions();
    vi.mocked(api.listSessions).mockRejectedValueOnce(new Error('session lookup failed'));
    await expect(hook.recordOpen(file)).resolves.toBeUndefined();
    expect(api.upsertRecentFile).not.toHaveBeenCalled();
    expect(render()).toMatchObject({
      error: 'session lookup failed', records: [file], currentSessionIds: null, loading: false,
    });
    await hook.recordOpen(file);
    expect(api.upsertRecentFile).toHaveBeenCalledWith(file, ['prod']);
    expect(render()).toMatchObject({ error: null, currentSessionIds: ['prod'] });
  });

  it('loads sessions even if history fails and handles mutation errors without rejection', async () => {
    vi.mocked(api.listRecentFiles).mockRejectedValue(new Error('history unavailable'));
    const { hook } = mount();
    await vi.waitFor(() => expect(render().loading).toBe(false));
    expect(render()).toMatchObject({ error: 'history unavailable', currentSessionIds: ['prod'] });
    vi.mocked(api.removeRecentFile).mockRejectedValueOnce('remove failed');
    await expect(hook.remove(file)).resolves.toBeUndefined();
    expect(render().error).toBe('remove failed');
    await hook.clear([file]);
    expect(render().error).toBeNull();
  });

  it('preserves an initial history storage error when sessions refresh successfully', async () => {
    vi.mocked(api.listRecentFiles).mockRejectedValueOnce(new Error('history unavailable'));
    const { hook } = mount();
    await hook.refreshSessions();
    expect(render()).toMatchObject({
      error: 'history unavailable', records: [], currentSessionIds: ['prod'], loading: false,
    });
  });

  it.each(['recordOpen', 'remove', 'clear'] as const)(
    'preserves a %s storage error when sessions refresh successfully', async (operation) => {
      const { hook } = mount();
      await hook.refreshSessions();
      if (operation === 'recordOpen') {
        vi.mocked(api.upsertRecentFile).mockRejectedValueOnce(new Error('storage unavailable'));
        await hook.recordOpen(file);
      } else if (operation === 'remove') {
        vi.mocked(api.removeRecentFile).mockRejectedValueOnce(new Error('storage unavailable'));
        await hook.remove(file);
      } else {
        vi.mocked(api.clearRecentFiles).mockRejectedValueOnce(new Error('storage unavailable'));
        await hook.clear([file]);
      }
      expect(render().error).toBe('storage unavailable');
      vi.mocked(api.listSessions).mockResolvedValue(sessions('fresh'));
      await hook.refreshSessions();
      expect(render()).toMatchObject({
        error: 'storage unavailable', records: [file], currentSessionIds: ['fresh'], loading: false,
      });
    },
  );

  it('invalidates a stale discovery snapshot when session refresh fails and recovers the queue', async () => {
    const { hook } = mount();
    await hook.refreshSessions();
    expect(render().currentSessionIds).toEqual(['prod']);
    vi.mocked(api.listSessions).mockRejectedValueOnce(new Error('session lookup failed'));
    await expect(hook.refreshSessions()).resolves.toBeUndefined();
    expect(render()).toMatchObject({
      error: 'session lookup failed', records: [file], currentSessionIds: null, loading: false,
    });
    vi.mocked(api.listSessions).mockResolvedValue(sessions('fresh'));
    await hook.refreshSessions();
    expect(render().currentSessionIds).toEqual(['fresh']);
    await hook.clear([file]);
    expect(render()).toMatchObject({ records: [], error: null, loading: false });
  });

  it('guards state and cancels queued work after unmount', async () => {
    const pending = deferred<api.Session[]>();
    const { hook, unmount } = mount();
    await hook.refreshSessions();
    vi.mocked(api.listSessions).mockReturnValue(pending.promise);
    const opening = hook.recordOpen(file);
    const removal = hook.remove(file);
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(3));
    unmount();
    const updatesAtUnmount = lifecycle.updates;
    pending.resolve(sessions('fresh'));
    await Promise.all([opening, removal]);
    expect(lifecycle.updates).toBe(updatesAtUnmount);
    expect(api.upsertRecentFile).not.toHaveBeenCalled();
    expect(api.removeRecentFile).not.toHaveBeenCalled();
  });
});
