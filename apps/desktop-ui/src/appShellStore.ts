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

function emitTransferLog(next: TransferLogSnapshot): void {
  transferLogSnapshot = next;
  transferLogListeners.forEach((listener) => listener());
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
    transferRecords: [...fulls, ...transferLogSnapshot.transferRecords].slice(0, 100),
  });
  return fulls.map((row) => row.id);
}

export function updateTransferRecord(
  id: string,
  patch: Partial<TransferRecord> | ((prev: TransferRecord) => Partial<TransferRecord>),
): void {
  let changed = false;
  const transferRecords = transferLogSnapshot.transferRecords.map((row) => {
    if (row.id !== id) return row;
    changed = true;
    const next: TransferRecord = {
      ...row,
      ...(typeof patch === 'function' ? patch(row) : patch),
    };
    if (isTransferTerminal(next.status) && next.endTime == null) {
      next.endTime = Date.now();
    }
    return next;
  });
  if (!changed) return;
  emitTransferLog({ ...transferLogSnapshot, transferRecords });
}

export function deleteTransferRecord(id: string): void {
  const transferRecords = transferLogSnapshot.transferRecords.filter((row) => row.id !== id);
  if (transferRecords.length === transferLogSnapshot.transferRecords.length) return;
  emitTransferLog({ ...transferLogSnapshot, transferRecords });
}