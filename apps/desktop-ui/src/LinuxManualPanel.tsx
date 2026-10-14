import { useEffect, useMemo, useRef } from 'react';
import { BookOpen, Search, X } from 'lucide-react';
import { searchLinuxManual } from './linuxManualModel';
import './LinuxManual.css';

export type LinuxManualPanelProps = {
  query: string;
  setQuery: (query: string) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  visible?: boolean;
};

export function LinuxManualPanel({ query, setQuery, selectedId, onSelect, visible = true }: LinuxManualPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchLinuxManual(query), [query]);
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  return (
    <section className="linux-manual-panel" aria-label="Linux 命令手册" hidden={!visible}>
      <header className="linux-manual-panel-header">
        <h2><BookOpen size={16} aria-hidden="true" />Linux 命令手册</h2>
        <div className="linux-manual-search">
          <Search size={15} aria-hidden="true" />
          <input ref={inputRef} type="search" aria-label="搜索命令名称或中文描述" placeholder="搜索命令或中文描述" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="清空搜索" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={14} /></button>}
        </div>
        <span className="linux-manual-result-count" role="status">{matches.length} 个命令</span>
      </header>
      <div className="linux-manual-command-list">
        {matches.length === 0 ? <p className="linux-manual-state">没有找到匹配的命令</p> : (
          <ul>
            {matches.map((entry) => <li key={entry.id}>
              <button type="button" className={`linux-manual-command${entry.id === selectedId ? ' is-selected' : ''}`} aria-current={entry.id === selectedId ? 'page' : undefined} onClick={() => onSelect(entry.id)}>
                <strong>{entry.name}</strong><span>{entry.description}</span>
              </button>
            </li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

export default LinuxManualPanel;
