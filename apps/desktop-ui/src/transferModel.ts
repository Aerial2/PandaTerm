/** 传输 / 日志数据模型（与 UI 组件解耦，供 store 与面板共用） */

export type TransferRecord = {
  id: string;
  fileName: string;
  direction: 'upload' | 'download' | 'open';
  target: string;
  size: number;
  status: 'pending' | 'uploading' | 'success' | 'failed' | 'cancelled';
  message: string;
  time: string;
  progress: number;
  transferred: number;
  speed: number;
  startTime: number;
  /** 终态时间戳；进行中为 null，用于计算耗时 */
  endTime: number | null;
};

export type LogEntry = {
  id: string;
  time: string;
  level: 'info' | 'warn' | 'error';
  text: string;
};

export function isTransferTerminal(status: TransferRecord['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'cancelled';
}

export function transferKindLabel(direction: TransferRecord['direction']): string {
  if (direction === 'download') return '下载';
  if (direction === 'open') return '加载';
  return '上传';
}