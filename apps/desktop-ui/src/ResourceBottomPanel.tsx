import { memo, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import {
  deleteTransferRecord,
  getTransferLogSnapshot,
  subscribeTransferLog,
} from './appShellStore';
import { LocalTerminalView } from './LocalTerminalView';
import {
  isTransferTerminal,
  transferKindLabel,
  type LogEntry,
  type TransferRecord,
} from './transferModel';

export type { LogEntry, TransferRecord };
export { isTransferTerminal, transferKindLabel };

export type ResourceBottomTab = 'transfer' | 'log' | 'local';

function formatFileSize(size: number) {
  if (size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const unitIndex = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(1024)), units.length - 1);
  const value = bytesPerSec / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatTransferDuration(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  if (totalMs < 1000) return `${totalMs}ms`;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function transferElapsedMs(record: Pick<TransferRecord, 'status' | 'startTime' | 'endTime'>): number {
  const end =
    record.endTime ??
    (record.status === 'pending' || record.status === 'uploading' ? Date.now() : record.startTime);
  return Math.max(0, end - record.startTime);
}

function transferStatusLabel(record: Pick<TransferRecord, 'direction' | 'status'>): string {
  const kind = transferKindLabel(record.direction);
  switch (record.status) {
    case 'pending':
      return '等待';
    case 'uploading':
      return `${kind}中`;
    case 'success':
      return '完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return record.status;
  }
}

function transferStatusDetail(record: Pick<TransferRecord, 'status' | 'message'>): string {
  if (record.status === 'failed' && record.message.trim()) return record.message.trim();
  if (record.status === 'cancelled' && record.message.trim()) return record.message.trim();
  return '';
}

type ResourceBottomPanelProps = {
  /** 取消进行中的传输（abort + store 更新由外部完成） */
  onCancelTransfer: (id: string) => void;
  /** 递增时切换到本地终端并展开 */
  openLocalTerminalKey?: number;
};

/**
 * 底部资源面板：tab / 折叠 / 高度 / 传输列表状态内聚。
 * 传输进度从 appShellStore 订阅，上传时不拖垮 App。
 */
export const ResourceBottomPanel = memo(function ResourceBottomPanel({
  onCancelTransfer,
  openLocalTerminalKey = 0,
}: ResourceBottomPanelProps) {
  const { transferRecords, logEntries } = useSyncExternalStore(
    subscribeTransferLog,
    getTransferLogSnapshot,
    getTransferLogSnapshot,
  );
  const [tab, setTab] = useState<ResourceBottomTab>('transfer');
  const [height, setHeight] = useState(180);
  const [collapsed, setCollapsed] = useState(false);
  const [transferContextMenu, setTransferContextMenu] = useState<{
    x: number;
    y: number;
    record: TransferRecord;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const expandedHeightRef = useRef(180);
  const lastOpenLocalKeyRef = useRef(0);

  function expandIfNeeded(minHeight = 0) {
    if (collapsed) {
      setCollapsed(false);
    }
    const next = Math.max(expandedHeightRef.current, minHeight || 0);
    if (minHeight > 0 && next > expandedHeightRef.current) {
      expandedHeightRef.current = next;
    }
    setHeight(next);
    if (panelRef.current) panelRef.current.style.height = `${next}px`;
  }

  function commitHeight(next: number) {
    expandedHeightRef.current = next;
    setHeight(next);
    if (panelRef.current) panelRef.current.style.height = `${next}px`;
  }

  function selectTab(next: ResourceBottomTab) {
    setTab(next);
    expandIfNeeded(next === 'local' ? 220 : 0);
  }

  useEffect(() => {
    if (!openLocalTerminalKey || openLocalTerminalKey === lastOpenLocalKeyRef.current) return;
    lastOpenLocalKeyRef.current = openLocalTerminalKey;
    selectTab('local');
  }, [openLocalTerminalKey]);

  useEffect(() => {
    if (!transferContextMenu) return;
    const close = () => setTransferContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [transferContextMenu]);

  const localActive = !collapsed && tab === 'local';

  return (
    <div
      className={`resource-bottom-panel${collapsed ? ' is-collapsed' : ''}`}
      ref={panelRef}
      style={collapsed ? undefined : { height }}
    >
      <div
        className="resource-bottom-resizer"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const startHeight = panelRef.current?.offsetHeight ?? height;
          dragRef.current = { startY: e.clientY, startHeight };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          const delta = drag.startY - e.clientY;
          const newHeight = Math.max(80, Math.min(drag.startHeight + delta, 500));
          expandedHeightRef.current = newHeight;
          if (panelRef.current) panelRef.current.style.height = `${newHeight}px`;
        }}
        onPointerUp={() => {
          if (dragRef.current) {
            commitHeight(expandedHeightRef.current);
          }
          dragRef.current = null;
        }}
      />
      <div className="resource-bottom-tabs">
        <div className="resource-bottom-tabs-left">
          <button
            type="button"
            className={tab === 'local' ? 'resource-bottom-tab active' : 'resource-bottom-tab'}
            onClick={() => selectTab('local')}
          >
            本地终端
          </button>
          <button
            type="button"
            className={tab === 'transfer' ? 'resource-bottom-tab active' : 'resource-bottom-tab'}
            onClick={() => selectTab('transfer')}
          >
            传输
          </button>
          <button
            type="button"
            className={tab === 'log' ? 'resource-bottom-tab active' : 'resource-bottom-tab'}
            onClick={() => selectTab('log')}
          >
            日志
          </button>
        </div>
        <button
          type="button"
          className="resource-bottom-collapse"
          title={collapsed ? '展开面板' : '折叠面板'}
          aria-label={collapsed ? '展开面板' : '折叠面板'}
          aria-expanded={!collapsed}
          onClick={() => {
            if (collapsed) {
              expandIfNeeded();
            } else {
              const current = panelRef.current?.offsetHeight ?? height;
              expandedHeightRef.current = current;
              setHeight(current);
              setCollapsed(true);
            }
          }}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      <div
        className="resource-bottom-content resource-local-terminal-wrap"
        hidden={collapsed || tab !== 'local'}
      >
        <LocalTerminalView active={localActive} />
      </div>

      <div
        className="resource-bottom-content transfer-table-wrap"
        hidden={collapsed || tab !== 'transfer'}
      >
        {transferRecords.length === 0 ? (
          <div className="resource-bottom-empty">暂无传输任务</div>
        ) : (
          <table className="transfer-table">
            <thead>
              <tr>
                <th className="transfer-th-index">序号</th>
                <th className="transfer-th-name">文件名称</th>
                <th className="transfer-th-metrics">大小 | 速度</th>
                <th className="transfer-th-time">时间 | 耗时</th>
                <th className="transfer-th-kind">类型 | 状态</th>
              </tr>
            </thead>
            <tbody>
              {transferRecords.map((record, idx) => {
                const statusLabel = transferStatusLabel(record);
                const statusDetail = transferStatusDetail(record);
                const elapsedLabel = formatTransferDuration(transferElapsedMs(record));
                const sizeLabel =
                  record.status === 'uploading' && record.progress >= 0
                    ? `${formatFileSize(record.transferred)} / ${formatFileSize(record.size)}`
                    : formatFileSize(record.size);
                const speedLabel =
                  record.status === 'uploading' && record.progress >= 0 && record.speed > 0
                    ? formatSpeed(record.speed)
                    : record.status === 'success' && record.speed > 0
                      ? formatSpeed(record.speed)
                      : '-';
                const speedClass =
                  record.status === 'uploading' && record.speed > 0
                    ? 'transfer-inline-value is-active'
                    : record.status === 'success' && record.speed > 0
                      ? 'transfer-inline-value is-avg'
                      : 'transfer-inline-value is-muted';
                const durationClass =
                  record.status === 'uploading' || record.status === 'pending'
                    ? 'transfer-inline-value is-active'
                    : 'transfer-inline-value';
                return (
                  <tr
                    key={record.id}
                    className={`transfer-row ${record.status}`}
                    onContextMenu={(event: MouseEvent) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setTransferContextMenu({ x: event.clientX, y: event.clientY, record });
                    }}
                  >
                    <td className="transfer-td-index">{idx + 1}</td>
                    <td className="transfer-td-name">
                      <div className="transfer-name-cell">
                        <span className="transfer-filename" title={record.fileName}>
                          {record.fileName}
                        </span>
                        {record.target ? (
                          <span className="transfer-target" title={record.target}>
                            {record.target}
                          </span>
                        ) : null}
                        {record.status === 'uploading' && record.progress >= 0 && (
                          <div className="transfer-progress-bar">
                            <div className="transfer-progress-fill" style={{ width: `${record.progress}%` }} />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="transfer-td-metrics" title={`${sizeLabel} | ${speedLabel}`}>
                      <span className="transfer-inline-text">
                        <span className="transfer-inline-value">{sizeLabel}</span>
                        <span className="transfer-inline-sep" aria-hidden>
                          |
                        </span>
                        <span className={speedClass}>{speedLabel}</span>
                      </span>
                    </td>
                    <td className="transfer-td-time" title={`${record.time} | ${elapsedLabel}`}>
                      <span className="transfer-inline-text">
                        <span className="transfer-inline-value is-muted">{record.time}</span>
                        <span className="transfer-inline-sep" aria-hidden>
                          |
                        </span>
                        <span className={durationClass}>{elapsedLabel}</span>
                      </span>
                    </td>
                    <td
                      className="transfer-td-kind"
                      title={statusDetail || `${transferKindLabel(record.direction)} | ${statusLabel}`}
                    >
                      <span className="transfer-inline-text">
                        <span className="transfer-inline-value">{transferKindLabel(record.direction)}</span>
                        <span className="transfer-inline-sep" aria-hidden>
                          |
                        </span>
                        <span className={`transfer-inline-value transfer-kind-status ${record.status}`}>
                          {statusLabel}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="resource-bottom-content resource-log-view" hidden={collapsed || tab !== 'log'}>
        {logEntries.length === 0 ? (
          <div className="resource-bottom-empty">暂无日志</div>
        ) : (
          logEntries.map((entry) => (
            <div key={entry.id} className={`resource-log-line ${entry.level}`}>
              <span className="resource-log-time">{entry.time}</span>
              <span className="resource-log-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>

      {transferContextMenu && (
        <div
          className="file-context-menu"
          style={{ left: transferContextMenu.x, top: transferContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {transferContextMenu.record.status === 'uploading' ||
          transferContextMenu.record.status === 'pending' ? (
            <button
              type="button"
              className="file-context-item danger"
              onClick={() => {
                onCancelTransfer(transferContextMenu.record.id);
                setTransferContextMenu(null);
              }}
            >
              取消{transferKindLabel(transferContextMenu.record.direction)}
            </button>
          ) : (
            <button
              type="button"
              className="file-context-item danger"
              onClick={() => {
                deleteTransferRecord(transferContextMenu.record.id);
                setTransferContextMenu(null);
              }}
            >
              <Trash2 size={15} /> 删除记录
            </button>
          )}
        </div>
      )}
    </div>
  );
});