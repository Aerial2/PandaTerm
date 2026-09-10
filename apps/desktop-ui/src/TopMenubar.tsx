import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Plus,
  Server,
  Settings,
} from 'lucide-react';
import {
  fetchLatestGithubVersion,
  getCurrentAppVersion,
  githubReleasesUrl,
  githubRepoUrl,
  isNewerVersion,
  openExternalUrl,
  PANDATERM_GITHUB_REPO,
  type LatestVersionResult,
} from './aboutModel';

const SHOW_IP_STORAGE_KEY = 'pandaterm.topStatus.showIp';

function readShowIpPreference(): boolean {
  try {
    const value = localStorage.getItem(SHOW_IP_STORAGE_KEY);
    if (value === null) return true;
    return value === '1';
  } catch {
    return true;
  }
}

function writeShowIpPreference(show: boolean) {
  try {
    localStorage.setItem(SHOW_IP_STORAGE_KEY, show ? '1' : '0');
  } catch {
    // ignore quota / private mode
  }
}

/** 隐藏主机：保留长度感，避免直接露出 IP / 域名 */
function maskHost(host: string): string {
  if (!host) return '••••';
  const len = Math.min(Math.max(host.length, 4), 16);
  return '•'.repeat(len);
}

type TopMenubarProps = {
  /** 会话名；空则不渲染状态区文字 */
  sessionName?: string;
  sessionUser?: string;
  sessionHost?: string;
  onOpenConnectionCreate: () => void;
  onOpenConnectionManage: () => void;
  onOpenAiSettings: () => void;
  onSetLeftActivity: (panel: 'files' | 'monitor' | 'processes' | 'ai') => void;
};

type AboutState = {
  currentVersion: string;
  latest: LatestVersionResult | null;
  loadingLatest: boolean;
  linkError: string | null;
};

/**
 * 顶部菜单独立 state，避免 activeMenu 切换拖垮整个 App 重渲染。
 */
export function TopMenubar({
  sessionName = '',
  sessionUser = '',
  sessionHost = '',
  onOpenConnectionCreate,
  onOpenConnectionManage,
  onOpenAiSettings,
  onSetLeftActivity,
}: TopMenubarProps) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [showIp, setShowIp] = useState(readShowIpPreference);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [about, setAbout] = useState<AboutState>({
    currentVersion: '…',
    latest: null,
    loadingLatest: false,
    linkError: null,
  });

  const hasSession = Boolean(sessionName || sessionUser || sessionHost);
  const displayHost = sessionHost ? (showIp ? sessionHost : maskHost(sessionHost)) : '';
  // name · user@host；缺省字段不硬拼 @
  const accountPart =
    sessionUser && displayHost
      ? `${sessionUser}@${displayHost}`
      : sessionUser || displayHost;
  const statusText = sessionName && accountPart
    ? `${sessionName} · ${accountPart}`
    : sessionName || accountPart;

  useEffect(() => {
    if (!activeMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menubar-item')) setActiveMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [activeMenu]);

  useEffect(() => {
    if (!aboutOpen) return;
    let cancelled = false;

    setAbout((prev) => ({ ...prev, loadingLatest: true, latest: null, linkError: null }));

    void (async () => {
      const currentVersion = await getCurrentAppVersion();
      if (cancelled) return;
      setAbout((prev) => ({ ...prev, currentVersion }));

      const latest = await fetchLatestGithubVersion();
      if (cancelled) return;
      setAbout({ currentVersion, latest, loadingLatest: false, linkError: null });
    })();

    return () => {
      cancelled = true;
    };
  }, [aboutOpen]);

  function runAndClose(action: () => void) {
    setActiveMenu(null);
    action();
  }

  function toggleShowIp() {
    setShowIp((current) => {
      const next = !current;
      writeShowIpPreference(next);
      return next;
    });
  }

  function openAbout() {
    setAboutOpen(true);
  }

  async function openAboutLink(url: string) {
    setAbout((current) => ({ ...current, linkError: null }));
    try {
      await openExternalUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAbout((current) => ({
        ...current,
        linkError: message || '系统浏览器打开失败',
      }));
    }
  }

  const latestLabel = about.loadingLatest
    ? '检查中…'
    : about.latest?.ok
      ? about.latest.version
      : about.latest
        ? '—'
        : '—';

  const latestHint = !about.loadingLatest && about.latest && !about.latest.ok
    ? about.latest.error
    : !about.loadingLatest && about.latest?.ok
      ? isNewerVersion(about.latest.version, about.currentVersion)
        ? '有新版本'
        : '已是最新'
      : null;

  const releaseUrl = about.latest?.ok
    ? about.latest.htmlUrl
    : githubReleasesUrl(PANDATERM_GITHUB_REPO);

  return (
    <>
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
          <div
            className="menubar-item"
            role="menuitem"
            tabIndex={0}
            onMouseEnter={() => {
              if (activeMenu) setActiveMenu('帮助');
            }}
            onClick={() => setActiveMenu(activeMenu === '帮助' ? null : '帮助')}
          >
            <span className="menubar-label">
              帮助<span className="menubar-accent">(H)</span>
            </span>
            {activeMenu === '帮助' && (
              <div className="menubar-dropdown" role="menu">
                <button
                  className="menubar-menu-item"
                  role="menuitem"
                  onClick={() => runAndClose(openAbout)}
                >
                  <Info size={14} />
                  <span>关于</span>
                </button>
              </div>
            )}
          </div>
        </nav>

        <div className="top-status">
          {hasSession && (
            <>
              <span
                className="top-status-text"
                title={showIp || !sessionHost ? statusText : undefined}
              >
                {statusText}
              </span>
              {sessionHost ? (
                <button
                  type="button"
                  className="top-status-ip-toggle"
                  onClick={toggleShowIp}
                  title={showIp ? '隐藏 IP' : '显示 IP'}
                  aria-label={showIp ? '隐藏 IP' : '显示 IP'}
                  aria-pressed={showIp}
                >
                  {showIp ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              ) : null}
            </>
          )}
        </div>
      </header>

      {aboutOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setAboutOpen(false)}>
          <div
            className="dialog-card about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-dialog-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="about-dialog-title">关于 PandaTerm</h3>
            <p className="about-dialog-desc">SSH 终端与运维工作台</p>
            <div className="about-dialog-rows">
              <div className="about-dialog-row">
                <span>当前版本</span>
                <strong>{about.currentVersion}</strong>
              </div>
              <div className="about-dialog-row">
                <span>最新版本</span>
                <strong className="about-dialog-latest">
                  {latestLabel}
                  {latestHint ? (
                    <em className={latestHint === '有新版本' ? 'update' : undefined}>
                      {latestHint}
                    </em>
                  ) : null}
                </strong>
              </div>
              <div className="about-dialog-row about-dialog-source">
                <span>检查来源</span>
                <a
                  className="about-dialog-link"
                  href={githubRepoUrl(PANDATERM_GITHUB_REPO)}
                  target="_blank"
                  rel="noreferrer"
                  title={PANDATERM_GITHUB_REPO}
                  onClick={(event) => {
                    event.preventDefault();
                    void openAboutLink(githubRepoUrl(PANDATERM_GITHUB_REPO));
                  }}
                >
                  GitHub · {PANDATERM_GITHUB_REPO}
                </a>
              </div>
            </div>
            {about.linkError ? (
              <p className="about-dialog-error">{about.linkError}</p>
            ) : !about.loadingLatest && about.latest && !about.latest.ok ? (
              <p className="about-dialog-error">{about.latest.error}</p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn"
                onClick={() => {
                  void openAboutLink(releaseUrl);
                }}
              >
                打开发布页
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                autoFocus
                onClick={() => setAboutOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}