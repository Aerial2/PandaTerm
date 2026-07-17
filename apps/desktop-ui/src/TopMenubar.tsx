import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Cpu,
  FolderOpen,
  Plus,
  Server,
  Settings,
} from 'lucide-react';

type TopMenubarProps = {
  sessionLabel: string;
  onOpenConnectionCreate: () => void;
  onOpenConnectionManage: () => void;
  onOpenAiSettings: () => void;
  onSetLeftActivity: (panel: 'files' | 'monitor' | 'processes' | 'ai') => void;
};

/**
 * 顶部菜单独立 state，避免 activeMenu 切换拖垮整个 App 重渲染。
 */
export function TopMenubar({
  sessionLabel,
  onOpenConnectionCreate,
  onOpenConnectionManage,
  onOpenAiSettings,
  onSetLeftActivity,
}: TopMenubarProps) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!activeMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menubar-item')) setActiveMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [activeMenu]);

  function runAndClose(action: () => void) {
    setActiveMenu(null);
    action();
  }

  return (
    <header className="top-strip">
      <nav className="menubar" role="menubar">
        <div
          className="menubar-item"
          role="menuitem"
          tabIndex={0}
          onMouseEnter={() => {
            if (activeMenu) setActiveMenu('连接');
          }}
          onClick={() => setActiveMenu(activeMenu === '连接' ? null : '连接')}
        >
          <span className="menubar-label">
            连接<span className="menubar-accent">(F)</span>
          </span>
          {activeMenu === '连接' && (
            <div className="menubar-dropdown" role="menu">
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(onOpenConnectionCreate)}
              >
                <Plus size={14} />
                <span>新建连接</span>
              </button>
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(onOpenConnectionManage)}
              >
                <Server size={14} />
                <span>连接管理</span>
              </button>
            </div>
          )}
        </div>
        <div
          className="menubar-item"
          role="menuitem"
          tabIndex={0}
          onMouseEnter={() => {
            if (activeMenu) setActiveMenu('编辑');
          }}
          onClick={() => setActiveMenu(activeMenu === '编辑' ? null : '编辑')}
        >
          <span className="menubar-label">
            编辑<span className="menubar-accent">(E)</span>
          </span>
          {activeMenu === '编辑' && (
            <div className="menubar-dropdown" role="menu">
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(onOpenAiSettings)}
              >
                <Settings size={14} />
                <span>AI 设置</span>
              </button>
            </div>
          )}
        </div>
        <div
          className="menubar-item"
          role="menuitem"
          tabIndex={0}
          onMouseEnter={() => {
            if (activeMenu) setActiveMenu('查看');
          }}
          onClick={() => setActiveMenu(activeMenu === '查看' ? null : '查看')}
        >
          <span className="menubar-label">
            查看<span className="menubar-accent">(V)</span>
          </span>
          {activeMenu === '查看' && (
            <div className="menubar-dropdown" role="menu">
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(() => onSetLeftActivity('files'))}
              >
                <FolderOpen size={14} />
                <span>文件资源管理器</span>
              </button>
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(() => onSetLeftActivity('monitor'))}
              >
                <Cpu size={14} />
                <span>系统监控</span>
              </button>
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(() => onSetLeftActivity('processes'))}
              >
                <Activity size={14} />
                <span>进程列表</span>
              </button>
              <button
                className="menubar-menu-item"
                role="menuitem"
                onClick={() => runAndClose(() => onSetLeftActivity('ai'))}
              >
                <Bot size={14} />
                <span>AI 助手</span>
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="top-status">{sessionLabel}</div>
    </header>
  );
}