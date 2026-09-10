import { useEffect, useRef, useState, type RefObject } from 'react';
import { getSystemMonitor, getProcessList, type ProcessInfo, type SystemMonitorData } from './api';
import { setStatusMessage } from './appShellStore';
import type { WorkspaceTab } from './terminalLayout';

type LeftActivity = 'files' | 'monitor' | 'processes' | 'ai' | null;
export type ProcessSortKey = 'cpu' | 'memory' | 'name';
export type ProcessSortDir = 'asc' | 'desc';

interface UseSystemMonitorParams {
  // 当前激活的左侧活动栏面板，决定是否轮询 monitor / processes
  leftActivity: LeftActivity;
  // 当前工作区 pane（读 ref 保证异步回调拿到实时目标，而非闭包旧值）
  activePaneTabRef: RefObject<WorkspaceTab | null>;
  // 由 App 注入：判断 pane 是本地还是远程终端
  isLocalResourceTab: (tab: WorkspaceTab | null) => boolean;
}

// 系统监控域：CPU/内存/磁盘采样 + 进程列表，各自串行轮询、按 generation 防串扰。
export function useSystemMonitor({ leftActivity, activePaneTabRef, isLocalResourceTab }: UseSystemMonitorParams) {
  const [monitorData, setMonitorData] = useState<SystemMonitorData | null>(null);
  const [isLoadingMonitor, setIsLoadingMonitor] = useState(false);
  const monitorRequestGenerationRef = useRef(0);
  const [processList, setProcessList] = useState<ProcessInfo[]>([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const processRequestGenerationRef = useRef(0);
  const [processSortKey, setProcessSortKey] = useState<ProcessSortKey>('cpu');
  const [processSortDir, setProcessSortDir] = useState<ProcessSortDir>('desc');
  const [processSearch, setProcessSearch] = useState('');

  /** 点击列头：同一列切换升序/降序；换列时回到该列的默认方向（数值列降序、名称升序） */
  function toggleProcessSort(key: ProcessSortKey) {
    if (key === processSortKey) {
      setProcessSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setProcessSortKey(key);
    setProcessSortDir(key === 'name' ? 'asc' : 'desc');
  }

  async function refreshMonitorData() {
    const generation = ++monitorRequestGenerationRef.current;
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    if (!local && !tab?.terminalId) {
      setMonitorData(null);
      setIsLoadingMonitor(false);
      setStatusMessage('远程终端尚未连接，无法获取系统监控数据');
      return;
    }
    const terminalId = local ? null : tab?.terminalId ?? null;
    const targetPaneId = tab?.id ?? null;
    const isCurrentTarget = () => {
      const currentTab = activePaneTabRef.current;
      const currentLocal = isLocalResourceTab(currentTab);
      const currentTerminalId = currentLocal ? null : currentTab?.terminalId ?? null;
      return generation === monitorRequestGenerationRef.current
        && targetPaneId === (currentTab?.id ?? null)
        && local === currentLocal
        && terminalId === currentTerminalId;
    };
    setIsLoadingMonitor(true);
    try {
      const data = await getSystemMonitor(terminalId);
      if (isCurrentTarget()) {
        setMonitorData(data);
      }
    } catch (error) {
      if (isCurrentTarget()) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage(`获取系统监控数据失败：${message}`);
      }
    } finally {
      if (isCurrentTarget()) setIsLoadingMonitor(false);
    }
  }

  async function refreshProcessList() {
    const generation = ++processRequestGenerationRef.current;
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    if (!local && !tab?.terminalId) {
      setProcessList([]);
      setIsLoadingProcesses(false);
      setStatusMessage('远程终端尚未连接，无法获取进程列表');
      return;
    }
    const terminalId = local ? null : tab?.terminalId ?? null;
    const targetPaneId = tab?.id ?? null;
    const isCurrentTarget = () => {
      const currentTab = activePaneTabRef.current;
      const currentLocal = isLocalResourceTab(currentTab);
      const currentTerminalId = currentLocal ? null : currentTab?.terminalId ?? null;
      return generation === processRequestGenerationRef.current
        && targetPaneId === (currentTab?.id ?? null)
        && local === currentLocal
        && terminalId === currentTerminalId;
    };
    setIsLoadingProcesses(true);
    try {
      const data = await getProcessList(terminalId);
      if (isCurrentTarget()) {
        setProcessList(data);
      }
    } catch (error) {
      if (isCurrentTarget()) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage(`获取进程列表失败：${message}`);
      }
    } finally {
      if (isCurrentTarget()) setIsLoadingProcesses(false);
    }
  }

  // Poll serially so a slow SSH sample cannot overlap with the next request.
  useEffect(() => {
    if (leftActivity !== 'monitor') return;
    let cancelled = false;
    let timeoutId: number | null = null;
    const poll = async () => {
      await refreshMonitorData();
      if (!cancelled) timeoutId = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      cancelled = true;
      monitorRequestGenerationRef.current++;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [leftActivity]);

  useEffect(() => {
    if (leftActivity !== 'processes') return;
    let cancelled = false;
    let timeoutId: number | null = null;
    const poll = async () => {
      await refreshProcessList();
      if (!cancelled) timeoutId = window.setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      processRequestGenerationRef.current++;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [leftActivity]);

  return {
    monitorData,
    isLoadingMonitor,
    processList,
    isLoadingProcesses,
    processSortKey,
    setProcessSortKey,
    processSortDir,
    toggleProcessSort,
    processSearch,
    setProcessSearch,
  };
}