import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock3, LoaderCircle, X } from 'lucide-react';
import { VscodeFileIcon } from './FileIcon';
import type { RecentFile, Session } from './api';
import './RecentFilesPanel.css';

export type RecentFilesPanelProps = {
  records: readonly RecentFile[];
  sessions: readonly Session[];
  loading: boolean;
  error?: string | null;
  onRemove: (record: RecentFile) => void;
  onOpen: (record: RecentFile) => void;
};

type RecentFileGroup = {
  id: string;
  name: string;
  records: RecentFile[];
};

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function groupRecentFiles(records: readonly RecentFile[], sessions: readonly Session[]): RecentFileGroup[] {
  const groups = new Map<string, RecentFileGroup>();
  for (const record of records) {
    const id = JSON.stringify([record.session_id, record.protocol, record.host, record.port, record.username]);
    let group = groups.get(id);
    if (!group) {
      const session = sessions.find((item) => item.id === record.session_id)
        ?? sessions.find((item) => item.protocol === record.protocol
          && item.host === record.host
          && item.port === record.port
          && item.username === record.username);
      group = {
        id,
        name: session?.name || `${record.username}@${record.host}`,
        records: [],
      };
      groups.set(id, group);
    }
    group.records.push(record);
  }
  return [...groups.values()];
}

export function RecentFilesPanel({
  records,
  sessions,
  loading,
  error,
  onRemove,
  onOpen,
}: RecentFilesPanelProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupRecentFiles(records, sessions), [records, sessions]);

  function toggleGroup(id: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="recent-files-panel" aria-label="最近文件">
      <header className="recent-files-header">
        <div className="recent-files-heading-row">
          <h2 className="recent-files-title">最近文件</h2>
        </div>
      </header>

      <div className="recent-files-body">
        {error && <div className="recent-files-notice recent-files-notice-error" role="alert">{error}</div>}
        {loading ? (
          <div className="recent-files-state" role="status">
            <LoaderCircle className="recent-files-spinner" size={22} aria-hidden="true" />
            <span>正在加载最近文件…</span>
          </div>
        ) : groups.length === 0 ? (
          <div className="recent-files-state">
            <Clock3 size={24} aria-hidden="true" />
            <strong>暂无最近文件</strong>
          </div>
        ) : (
          <div className="recent-files-groups">
            {groups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              const Chevron = expanded ? ChevronDown : ChevronRight;
              return (
                <section className="recent-files-group" key={group.id}>
                  <button
                    type="button"
                    className="recent-files-group-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <Chevron size={16} aria-hidden="true" />
                    <strong title={group.name}>{group.name}</strong>
                    <span>{group.records.length}</span>
                  </button>
                  {expanded && (
                    <ul className="recent-files-list">
                      {group.records.map((record) => (
                        <li className="recent-files-item" key={`${record.session_id}:${record.protocol}:${record.host}:${record.port}:${record.username}:${record.path}`}>
                          <button type="button" className="recent-files-item-main" onClick={() => onOpen(record)} title={`打开 ${record.path}`}>
                            <span className="recent-files-item-icon" aria-hidden="true">
                              <VscodeFileIcon filename={record.name || record.path} isDirectory={record.kind === 'directory'} size={16} />
                            </span>
                            <span className="recent-files-item-copy">
                              <strong>{record.name || record.path}</strong>
                              <span className="recent-files-item-path" title={record.path}>{record.path}</span>
                              <span className="recent-files-item-meta">{formatOpenedAt(record.opened_at)}</span>
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
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
