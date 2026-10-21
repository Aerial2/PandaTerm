import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  listLocalPortForwards, saveLocalPortForwards, startLocalPortForward, stopLocalPortForward,
  type LocalPortForward, type PortForwardSnapshot, type PortForwardsChanged, type Session,
} from './api';
import type { WorkspaceTab } from './terminalLayout';
import { acceptsSnapshot, portForwardDisabledReason } from './portForwardModel';

type Params = {
  activePaneTab: WorkspaceTab | null;
  activePaneTabRef: RefObject<WorkspaceTab | null>;
  onSessionsChanged: (sessions: Session[]) => void;
};
type Runtime = {
  key: string; alive: boolean; snapshot: PortForwardSnapshot | null;
  request: number; retired: Set<string>; busy: boolean;
};
function targetKey(tab: WorkspaceTab | null) {
  return JSON.stringify([tab?.id, tab?.session.id, tab?.terminalId, tab?.status, tab?.kind]);
}

export function usePortForwards({ activePaneTab, activePaneTabRef, onSessionsChanged }: Params) {
  const key = targetKey(activePaneTab);
  const runtimeRef = useRef<Runtime>({ key, alive: true, snapshot: null, request: 0, retired: new Set(), busy: false });
  if (runtimeRef.current.key !== key) {
    runtimeRef.current.alive = false;
    runtimeRef.current = { key, alive: true, snapshot: null, request: 0, retired: new Set(), busy: false };
  }
  const runtime = runtimeRef.current;
  const [view, setView] = useState<{ runtime: Runtime; loading: boolean; busy: boolean; error: string | null }>(
    { runtime, loading: false, busy: false, error: null },
  );
  const current = (owner: Runtime) => owner.alive && runtimeRef.current === owner && targetKey(activePaneTabRef.current) === owner.key;
  const update = (owner: Runtime, patch: Partial<Omit<typeof view, 'runtime'>>) => {
    if (current(owner)) setView((previous) => ({ ...(previous.runtime === owner ? previous : { loading: false, busy: false, error: null }), runtime: owner, ...patch }));
  };
  const apply = (owner: Runtime, next: PortForwardSnapshot, terminalId: string, authoritative: boolean) => {
    if (!current(owner) || owner.retired.has(next.generation) || !acceptsSnapshot(owner.snapshot, next, terminalId, authoritative)) return false;
    if (owner.snapshot && next.generation !== owner.snapshot.generation) owner.retired.add(owner.snapshot.generation);
    owner.snapshot = next;
    update(owner, {});
    return true;
  };

  const refresh = useCallback(async () => {
    const owner = runtimeRef.current;
    const tab = activePaneTabRef.current;
    if (portForwardDisabledReason(tab) || !tab) return null;
    const request = ++owner.request;
    update(owner, { loading: true });
    try {
      const next = await listLocalPortForwards(tab.terminalId);
      if (request !== owner.request || !apply(owner, next, tab.terminalId, true)) return null;
      update(owner, { error: null });
      return next;
    } catch (cause) {
      if (request === owner.request) update(owner, { error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally {
      if (request === owner.request) update(owner, { loading: false });
    }
  }, [key, activePaneTabRef]);

  useEffect(() => {
    runtime.alive = true;
    void refresh();
    return () => { runtime.alive = false; };
  }, [runtime, refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<PortForwardsChanged | PortForwardSnapshot>('port-forwards-changed', ({ payload }) => {
      if (disposed || !current(runtime) || payload.terminal_id !== activePaneTabRef.current?.terminalId) return;
      if (runtime.retired.has(payload.generation)) return;
      if (runtime.snapshot?.generation === payload.generation && payload.revision <= runtime.snapshot.revision) return;
      // Event bodies, including full snapshots, are refresh hints. Lists are authoritative.
      void refresh();
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; }).catch((cause) => {
      update(runtime, { error: `无法订阅隧道状态：${String(cause)}` });
    });
    return () => { disposed = true; unlisten?.(); };
  }, [runtime, refresh, activePaneTabRef]);

  async function operation(action: (owner: Runtime, tab: WorkspaceTab) => Promise<void>) {
    const owner = runtimeRef.current;
    const tab = activePaneTabRef.current;
    if (!tab || !current(owner)) throw new Error('连接目标已改变');
    if (owner.busy) throw new Error('请等待当前隧道操作完成');
    owner.busy = true;
    update(owner, { busy: true, error: null });
    try { await action(owner, tab); }
    catch (cause) {
      update(owner, { error: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    } finally { owner.busy = false; update(owner, { busy: false }); }
  }
  function requireCurrent(owner: Runtime) {
    if (!current(owner)) throw new Error('连接目标已改变，请在当前终端重试');
  }
  async function fresh(owner: Runtime, tab: WorkspaceTab) {
    requireCurrent(owner);
    const next = await listLocalPortForwards(tab.terminalId);
    requireCurrent(owner);
    if (!apply(owner, next, tab.terminalId, true)) throw new Error('隧道状态已改变，请刷新后重试');
    return next;
  }
  async function stopInstance(owner: Runtime, tab: WorkspaceTab, ruleId: string, instanceId: string) {
    const generation = owner.snapshot?.generation;
    const next = await stopLocalPortForward(tab.terminalId, ruleId, instanceId);
    requireCurrent(owner);
    if (next.generation !== generation || owner.snapshot?.generation !== generation) {
      void refresh();
      throw new Error('SSH 连接或隧道实例已改变，请刷新后重试');
    }
    // A hint may have already refreshed a newer revision while this command was pending.
    const confirmed = apply(owner, next, tab.terminalId, false) ? next : await fresh(owner, tab);
    if (confirmed.generation !== generation) throw new Error('SSH 连接已改变，请刷新后重试');
    if (confirmed.forwards.some((status) => status.rule_id === ruleId)) throw new Error('隧道尚未停止，请等待端口释放后重试');
  }
  async function startInstance(owner: Runtime, tab: WorkspaceTab, ruleId: string) {
    requireCurrent(owner);
    const generation = owner.snapshot?.generation;
    const next = await startLocalPortForward(tab.terminalId, ruleId);
    requireCurrent(owner);
    if (next.generation !== generation || owner.snapshot?.generation !== generation) {
      void refresh();
      throw new Error('SSH 连接已改变，请刷新状态后手动启用');
    }
    const confirmed = apply(owner, next, tab.terminalId, false) ? next : await fresh(owner, tab);
    if (confirmed.generation !== generation) throw new Error('SSH 连接已改变，请刷新状态后手动启用');
  }
  const saveRules = (rules: LocalPortForward[], changedRuleId?: string, startRuleId?: string) => operation(async (owner, tab) => {
    // Only the focused terminal's runtime is stopped; profiles may be shared by other terminals.
    if (!portForwardDisabledReason(tab)) {
      const before = await fresh(owner, tab);
      const active = before.forwards.find((status) => status.rule_id === changedRuleId);
      if (active) await stopInstance(owner, tab, active.rule_id, active.instance_id);
    }
    requireCurrent(owner);
    const sessions = await saveLocalPortForwards(tab.session.id, rules);
    // Persisted rules are global even when focus changed during the save.
    onSessionsChanged(sessions);
    requireCurrent(owner);
    if (startRuleId) {
      if (portForwardDisabledReason(activePaneTabRef.current)) throw new Error('规则已保存，SSH 连接后请手动启用');
      await startInstance(owner, tab, startRuleId);
    }
  });
  const start = (ruleId: string) => operation(async (owner, tab) => {
    const reason = portForwardDisabledReason(tab);
    if (reason) throw new Error(reason);
    const before = await fresh(owner, tab);
    const failed = before.forwards.find((status) => status.rule_id === ruleId && status.state === 'failed');
    if (failed) await stopInstance(owner, tab, ruleId, failed.instance_id);
    await startInstance(owner, tab, ruleId);
  });
  const stop = (ruleId: string, instanceId: string) => operation(async (owner, tab) => {
    const reason = portForwardDisabledReason(tab);
    if (reason) throw new Error(reason);
    const before = await fresh(owner, tab);
    const status = before.forwards.find((item) => item.rule_id === ruleId);
    if (!status) return;
    if (status.instance_id !== instanceId) throw new Error('隧道实例已改变，请刷新后重试');
    await stopInstance(owner, tab, ruleId, instanceId);
  });
  const visible = view.runtime === runtime ? view : { loading: false, busy: false, error: null };
  return { snapshot: runtime.snapshot, ...visible, disabledReason: portForwardDisabledReason(activePaneTab), refresh, saveRules, start, stop };
}
