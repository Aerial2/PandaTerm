/**
 * App 壳层高频状态外置 store。
 * 传输进度 / 日志 / 状态栏消息若放在 App useState，会每帧拖垮 9000+ 行组件树。
 * 订阅方用 useSyncExternalStore，写入不触发 App 重渲染。
 */
import {
  isTransferTerminal,
  type LogEntry,
  type TransferRecord,
} from './transferModel';

// ─── status bar ─────────────────────────────────────────────

let statusMessage = '';
const statusListeners = new Set<() => void>();

export function getStatusMessage(): string {
  return statusMessage;
}

export function setStatusMessage(message: string): void {
  if (statusMessage === message) return;
  statusMessage = message;
  statusListeners.forEach((listener) => listener());
}

export function subscribeStatusMessage(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

// ─── transfer + log ─────────────────────────────────────────

export type TransferLogSnapshot = {
  transferRecords: TransferRecord[];
  logEntries: LogEntry[];
};

let transferLogSnapshot: TransferLogSnapshot = {
  transferRecords: [],
  logEntries: [],
};
const transferLogListeners = new Set<() => void>();
/** 进度类写入合并到下一帧再通知 UI，避免高频进度事件拖垮列表 */
let transferLogRaf: number | null = null;

function flushTransferLogListeners(): void {
  if (transferLogRaf != null) {
    cancelAnimationFrame(transferLogRaf);
    transferLogRaf = null;
  }
  transferLogListeners.forEach((listener) => listener());
}

function scheduleTransferLogListeners(): void {
  if (transferLogRaf != null) return;
  transferLogRaf = requestAnimationFrame(() => {
    transferLogRaf = null;
    transferLogListeners.forEach((listener) => listener());
  });
}

/** sync：立刻通知（增删/终态）；raf：同帧多次进度更新只通知一次 */
function emitTransferLog(next: TransferLogSnapshot, mode: 'sync' | 'raf' = 'sync'): void {
  transferLogSnapshot = next;
  if (mode === 'sync') {
    flushTransferLogListeners();
    return;
  }
  scheduleTransferLogListeners();
}

export function getTransferLogSnapshot(): TransferLogSnapshot {
  return transferLogSnapshot;
}

export function subscribeTransferLog(listener: () => void): () => void {
  transferLogListeners.add(listener);
  return () => {
    transferLogListeners.delete(listener);
  };
}

export function addLogEntry(level: LogEntry['level'], text: string): void {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    level,
    text,
  };
  emitTransferLog({
    ...transferLogSnapshot,
    logEntries: [...transferLogSnapshot.logEntries, entry].slice(-200),
  });
}

export function addTransferRecord(
  record: Omit<TransferRecord, 'id' | 'time' | 'progress' | 'transferred' | 'speed' | 'startTime' | 'endTime'>,
): string {
  return addTransferRecords([record])[0];
}

/** 批量入队：保持传入顺序（第一条在列表顶部），用于多文件等待展示 */
export function addTransferRecords(
  records: Omit<TransferRecord, 'id' | 'time' | 'progress' | 'transferred' | 'speed' | 'startTime' | 'endTime'>[],
): string[] {
  if (records.length === 0) return [];
  const now = Date.now();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fulls: TransferRecord[] = records.map((record, index) => ({
    ...record,
    id: `${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    time,
    progress: 0,
    transferred: 0,
    speed: 0,
    startTime: now,
    endTime: null,
  }));
  emitTransferLog({
    ...transferLogSnapshot,
    // 不截断：条数上限交给 UI 虚拟列表承担渲染成本
    transferRecords: [...fulls, ...transferLogSnapshot.transferRecords],
  });
  return fulls.map((row) => row.id);
}

function transferRecordChanged(prev: TransferRecord, next: TransferRecord): boolean {
  return (
    prev.fileName !== next.fileName ||
    prev.direction !== next.direction ||
    prev.target !== next.target ||
    prev.size !== next.size ||
    prev.status !== next.status ||
    prev.message !== next.message ||
    prev.time !== next.time ||
    prev.progress !== next.progress ||
    prev.transferred !== next.transferred ||
    prev.speed !== next.speed ||
    prev.startTime !== next.startTime ||
    prev.endTime !== next.endTime
  );
}

export function updateTransferRecord(
  id: string,
  patch: Partial<TransferRecord> | ((prev: TransferRecord) => Partial<TransferRecord>),
): void {
  const index = transferLogSnapshot.transferRecords.findIndex((row) => row.id === id);
  if (index < 0) return;
  const row = transferLogSnapshot.transferRecords[index];
  const next: TransferRecord = {
    ...row,
    ...(typeof patch === 'function' ? patch(row) : patch),
  };
  if (isTransferTerminal(next.status) && next.endTime == null) {
    next.endTime = Date.now();
  }
  if (!transferRecordChanged(row, next)) return;

  const transferRecords = transferLogSnapshot.transferRecords.slice();
  transferRecords[index] = next;
  // 终态立刻刷新；进度/速度等高频字段合并到 rAF
  const mode = isTransferTerminal(next.status) || next.status !== row.status ? 'sync' : 'raf';
  emitTransferLog({ ...transferLogSnapshot, transferRecords }, mode);
}

export function deleteTransferRecord(id: string): void {
  const transferRecords = transferLogSnapshot.transferRecords.filter((row) => row.id !== id);
  if (transferRecords.length === transferLogSnapshot.transferRecords.length) return;
  emitTransferLog({ ...transferLogSnapshot, transferRecords });
}