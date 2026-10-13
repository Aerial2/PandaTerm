import { useMemo } from 'react';
import { Clock3, LoaderCircle, Search, Trash2, X } from 'lucide-react';
import { VscodeFileIcon } from './FileIcon';
import type { RecentFile } from './api';
import { filterRecentFiles } from './recentFilesModel';
import './RecentFilesPanel.css';

export type RecentFilesPanelProps = {
  records: readonly RecentFile[];
  loading: boolean;
  error?: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onRemove: (record: RecentFile) => void;
  onClear: () => void;
  onOpen: (record: RecentFile) => void;
  /** Optional connection state message; history remains available when disconnected. */
  connectionMessage?: string | null;
};

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function protocolLabel(protocol: RecentFile['protocol']): string {
  return protocol.toUpperCase();
}

export function RecentFilesPanel({
  records,
  loading,
  error,
  query,
  onQueryChange,
  onRemove,
  onClear,
  onOpen,
  connectionMessage,
}: RecentFilesPanelProps) {
  const visibleRecords = useMemo(() => filterRecentFiles(records, { query }), [records, query]);

  return (
    <section className="recent-files-panel" aria-label="最近文件">
      <header className="recent-files-header">
        <div className="recent-files-heading-row">
          <div>
            <h2 className="recent-files-title">最近文件</h2>
            <p className="recent-files-count">共 {records.length} 项</p>
          </div>
          <button
            type="button"
            className="recent-files-clear-button"
            title="清空最近文件"
            aria-label="清空最近文件"
            disabled={loading || records.length === 0}
            onClick={onClear}
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>清空</span>
          </button>
        </div>
        <div className="recent-files-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索最近文件"
            type="search"
            value={query}
            placeholder="搜索文件、主机或用户"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="recent-files-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => onQueryChange('')}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div className="recent-files-body">
        {connectionMessage && (
          <div className="recent-files-notice" role="status">{connectionMessage}</div>
        )}
        {error && (
          <div className="recent-files-notice recent-files-notice-error" role="alert">{error}</div>
        )}
        {loading ? (
          <div className="recent-files-state" role="status">
            <LoaderCircle className="recent-files-spinner" size={22} aria-hidden="true" />
            <span>正在加载最近文件…</span>
          </div>
        ) : visibleRecords.length === 0 ? (
          <div className="recent-files-state">
            <Clock3 size={24} aria-hidden="true" />
            <strong>{query ? '没有匹配的文件' : '暂无最近文件'}</strong>
            <span>{query ? '请尝试其他搜索关键词。' : '通过远程会话打开的文件将显示在这里。'}</span>
          </div>
        ) : (
          <ul className="recent-files-list">
            {visibleRecords.map((record) => (
              <li className="recent-files-item" key={`${record.session_id}:${record.protocol}:${record.host}:${record.port}:${record.username}:${record.path}`}>
                <button type="button" className="recent-files-item-main" onClick={() => onOpen(record)} title={`打开 ${record.path}`}>
                  <span className="recent-files-item-icon" aria-hidden="true">
                    <VscodeFileIcon filename={record.name || record.path} isDirectory={record.kind === 'directory'} size={19} />
                  </span>
                  <span className="recent-files-item-copy">
                    <strong>{record.name || record.path}</strong>
                    <span className="recent-files-item-path" title={record.path}>{record.path}</span>
                    <span className="recent-files-item-meta">
                      {protocolLabel(record.protocol)} · {record.username}@{record.host}:{record.port} · {formatOpenedAt(record.opened_at)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="recent-files-remove"
                  title={`移除 ${record.name || record.path}`}
                  aria-label={`移除 ${record.name || record.path}`}
                  onClick={() => onRemove(record)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
