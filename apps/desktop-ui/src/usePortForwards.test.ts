import { beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], listeners: [] as ((event: any) => void)[] }));
vi.mock('react', () => ({
  useRef: (initial: unknown) => { const i = harness.cursor++; return harness.slots[i] ??= { current: initial }; },
  useState: (initial: unknown) => { const i = harness.cursor++; if (!(i in harness.slots)) harness.slots[i] = initial; return [harness.slots[i], (next: any) => { harness.slots[i] = typeof next === 'function' ? next(harness.slots[i]) : next; }]; },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const i = harness.cursor++; const previous = harness.slots[i];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) harness.slots[i] = { deps, callback };
    return harness.slots[i].callback;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = harness.cursor++; const previous = harness.slots[i];
    if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
      harness.effects.push(() => { previous?.cleanup?.(); harness.slots[i] = { deps, cleanup: effect() }; });
    }
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_event, listener) => { harness.listeners.push(listener); return () => { harness.listeners = harness.listeners.filter((value) => value !== listener); }; }) }));
vi.mock('./api', () => ({ listLocalPortForwards: vi.fn(), saveLocalPortForwards: vi.fn(), startLocalPortForward: vi.fn(), stopLocalPortForward: vi.fn() }));
import * as api from './api';
import { usePortForwards } from './usePortForwards';
import type { WorkspaceTab } from './terminalLayout';
const base: WorkspaceTab = { id: 'a', kind: 'terminal', terminalId: 'ta', status: 'connected', title: '', output: [], closedByUser: false, reconnectAttempts: 0, activityLog: [], session: { id: 'profile', name: 'SSH', host: 'host', port: 22, username: 'u', group: '', auth: { type: 'agent' }, tags: [], reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 } } };
const snapshot = (terminal_id = 'ta', generation = 'g1', revision = 1, forwards: api.PortForwardStatus[] = []): api.PortForwardSnapshot => ({ terminal_id, generation, revision, forwards });
const status: api.PortForwardStatus = { rule_id: 'rule', instance_id: 'instance', state: 'listening', local_host: '127.0.0.1', local_port: 18685, remote_host: '127.0.0.1', remote_port: 18685 };
let tab: WorkspaceTab | null;
let ref: { current: WorkspaceTab | null };
let changed: ReturnType<typeof vi.fn<(sessions: api.Session[]) => void>>;
function render(next = tab) { tab = next; ref.current = tab; harness.cursor = 0; const result = usePortForwards({ activePaneTab: tab, activePaneTabRef: ref, onSessionsChanged: changed }); const effects = harness.effects.splice(0); effects.forEach((effect) => effect()); return result; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.resetAllMocks(); harness.slots = []; harness.cursor = 0; harness.effects = []; harness.listeners = [];
  tab = base; ref = { current: tab }; changed = vi.fn();
  vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot());
  vi.mocked(api.startLocalPortForward).mockResolvedValue(snapshot('ta', 'g1', 2, [status]));
  vi.mocked(api.stopLocalPortForward).mockResolvedValue(snapshot('ta', 'g1', 3));
  vi.mocked(api.saveLocalPortForwards).mockResolvedValue([base.session]);
});
describe('usePortForwards runtime ownership', () => {
  it('isolates terminals sharing a saved profile and discards stale list responses', async () => {
    const pending = deferred<api.PortForwardSnapshot>();
    vi.mocked(api.listLocalPortForwards).mockReturnValueOnce(pending.promise);
    render();
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('tb', 'gb'));
    render({ ...base, id: 'b', terminalId: 'tb' }); await settle();
    pending.resolve(snapshot('ta', 'g1', 10, [status])); await settle();
    expect(render().snapshot).toEqual(snapshot('tb', 'gb'));
    expect(api.listLocalPortForwards).toHaveBeenCalledWith('tb');
  });
  it('rejects old start completion after switching away and back, including errors and busy state', async () => {
    render(); await settle();
    const pending = deferred<api.PortForwardSnapshot>();
    vi.mocked(api.startLocalPortForward).mockReturnValue(pending.promise);
    const starting = render().start('rule'); await settle();
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('tb', 'gb'));
    render({ ...base, id: 'b', terminalId: 'tb' }); await settle();
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot());
    render(base); await settle();
    pending.resolve(snapshot('ta', 'g1', 50, [status]));
    await expect(starting).rejects.toThrow('目标已改变');
    expect(render()).toMatchObject({ snapshot: snapshot(), busy: false, error: null });
  });
  it('uses full events only as hints, ignores other terminals/old revisions/retired generations', async () => {
    render(); await settle();
    const calls = vi.mocked(api.listLocalPortForwards).mock.calls.length;
    const emit = (payload: api.PortForwardsChanged | api.PortForwardSnapshot) => harness.listeners.forEach((listener) => listener({ payload }));
    emit(snapshot('other', 'g1', 9)); emit(snapshot('ta', 'g1', 1, [status]));
    await settle(); expect(api.listLocalPortForwards).toHaveBeenCalledTimes(calls);
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g2', 1));
    emit(snapshot('ta', 'g2', 99, [status])); await settle();
    expect(render().snapshot).toEqual(snapshot('ta', 'g2', 1));
    emit(snapshot('ta', 'g1', 100)); await settle();
    expect(api.listLocalPortForwards).toHaveBeenCalledTimes(calls + 1);
  });
  it('never lets lower revisions replace a newer runtime snapshot', async () => {
    render(); await settle();
    vi.mocked(api.listLocalPortForwards).mockResolvedValueOnce(snapshot('ta', 'g1', 8, [status]));
    await render().refresh();
    vi.mocked(api.listLocalPortForwards).mockResolvedValueOnce(snapshot('ta', 'g1', 2));
    await render().refresh();
    expect(render().snapshot?.revision).toBe(8);
  });
  it('stops the current exact instance before saving edited/deleted rules', async () => {
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 2, [status]));
    render(); await settle(); await render().saveRules([], 'rule');
    expect(api.stopLocalPortForward).toHaveBeenCalledWith('ta', 'rule', 'instance');
    expect(vi.mocked(api.stopLocalPortForward).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.saveLocalPortForwards).mock.invocationCallOrder[0]);
    expect(api.saveLocalPortForwards).toHaveBeenCalledWith('profile', []);
    expect(changed).toHaveBeenCalledWith([base.session]);
  });
  it('does not save or start after a failed stop; preserves an error for retry', async () => {
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 2, [status]));
    vi.mocked(api.stopLocalPortForward).mockRejectedValue(new Error('port still open'));
    render(); await settle(); await expect(render().saveRules([], 'rule', 'rule')).rejects.toThrow('port still open');
    expect(api.saveLocalPortForwards).not.toHaveBeenCalled(); expect(api.startLocalPortForward).not.toHaveBeenCalled();
    expect(render()).toMatchObject({ error: 'port still open', busy: false });
  });
  it('clears a failed instance with its exact guard before retrying start', async () => {
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 2, [{ ...status, state: 'failed' }]));
    vi.mocked(api.startLocalPortForward).mockResolvedValue(snapshot('ta', 'g1', 4, [status]));
    render(); await settle(); await render().start('rule');
    expect(api.stopLocalPortForward).toHaveBeenCalledWith('ta', 'rule', 'instance');
    expect(vi.mocked(api.stopLocalPortForward).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.startLocalPortForward).mock.invocationCallOrder[0]);
  });
  it('rejects stale stop instance IDs and stopping responses without deleting rules', async () => {
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 2, [status]));
    render(); await settle(); await expect(render().stop('rule', 'old')).rejects.toThrow('实例已改变');
    expect(api.stopLocalPortForward).not.toHaveBeenCalled();
    vi.mocked(api.stopLocalPortForward).mockResolvedValue(snapshot('ta', 'g1', 3, [{ ...status, state: 'stopping' }]));
    await expect(render().saveRules([], 'rule')).rejects.toThrow('尚未停止');
    expect(api.saveLocalPortForwards).not.toHaveBeenCalled();
  });
  it('propagates persisted sessions after a target switch but skips save-and-start continuation', async () => {
    render(); await settle(); const pending = deferred<api.Session[]>();
    vi.mocked(api.saveLocalPortForwards).mockReturnValue(pending.promise);
    const saving = render().saveRules([], undefined, 'rule'); await settle();
    render({ ...base, id: 'b', terminalId: 'tb' });
    pending.resolve([base.session]); await expect(saving).rejects.toThrow('目标已改变');
    expect(changed).toHaveBeenCalledWith([base.session]); expect(api.startLocalPortForward).not.toHaveBeenCalled();
  });
  it('confirms command completion with an authoritative refresh when an event already applied a newer revision', async () => {
    render(); await settle();
    const pending = deferred<api.PortForwardSnapshot>();
    vi.mocked(api.startLocalPortForward).mockReturnValue(pending.promise);
    const starting = render().start('rule'); await settle();
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 4, [status]));
    harness.listeners.forEach((listener) => listener({ payload: { terminal_id: 'ta', generation: 'g1', revision: 4 } }));
    await settle(); pending.resolve(snapshot('ta', 'g1', 2, [status]));
    await expect(starting).resolves.toBeUndefined();
    expect(render()).toMatchObject({ snapshot: snapshot('ta', 'g1', 4, [status]), error: null });
  });
  it('clears runtime on disconnect and never auto-starts saved rules after reconnect', async () => {
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g1', 2, [status]));
    render(); await settle();
    expect(render({ ...base, status: 'disconnected' }).snapshot).toBeNull();
    vi.mocked(api.listLocalPortForwards).mockResolvedValue(snapshot('ta', 'g2', 0));
    render(base); await settle(); expect(render().snapshot).toEqual(snapshot('ta', 'g2', 0));
    expect(api.startLocalPortForward).not.toHaveBeenCalled();
  });
});
