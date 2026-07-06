import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Plus,
  Edit,
  Trash2,
  Search,
  Server,
  X,
  Monitor,
  Copy,
} from 'lucide-react';
import {
  listSessions,
  saveSession,
  deleteSession,
  openConnectionWindow,
} from './api';
import type { Session, AuthType } from './api';
import './styles.css';

type ConnectionAuthMethod = 'password' | 'public_key' | 'keyboard_interactive' | 'gssapi';

type ConnectionFormState = {
  name: string;
  host: string;
  username: string;
  port: string;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  keyboardInteractiveResponse: string;
  gssapiPrincipal: string;
};

const initialConnectionForm: ConnectionFormState = {
  name: '',
  host: '',
  username: '',
  port: '22',
  password: '',
  privateKeyPath: '',
  privateKeyPassphrase: '',
  keyboardInteractiveResponse: '',
  gssapiPrincipal: '',
};

type ConnectionWindowMode = 'manage' | 'create';

type ContextMenuState = {
  x: number;
  y: number;
  session: Session;
} | null;

const localSession: Session = {
  id: 'local-system',
  name: '本地终端',
  group: 'Local',
  host: 'localhost',
  port: 0,
  username: '',
  auth: { type: 'agent' },
  tags: ['local'],
  last_connected_at: null,
  reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
};

export function ConnectionWindow() {
  const windowLabelRef = useRef<string>('connection-panel');
  const [windowLabel, setWindowLabel] = useState<string>('connection-panel');
  const [mode, setMode] = useState<ConnectionWindowMode>('manage');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [connectionSearchQuery, setConnectionSearchQuery] = useState('');
  const [connectionAuthMethod, setConnectionAuthMethod] = useState<ConnectionAuthMethod>('password');
  const [connectionForm, setConnectionForm] = useState<ConnectionFormState>(initialConnectionForm);
  const [connectionFormError, setConnectionFormError] = useState('');
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshSessions();

    // Listen for mode change events — only accept events intended for THIS window.
    // Each event payload should specify a target label so windows don't interfere.
    const unlisten = listen<{ mode: ConnectionWindowMode; target: string }>('connection-window-set-mode', (event) => {
      // Only react if the event is targeted at this window's label
      if (event.payload.target !== windowLabelRef.current) return;
      // connection-create window only shows create mode — ignore manage requests
      if (windowLabelRef.current === 'connection-create' && event.payload.mode === 'manage') return;
      setMode(event.payload.mode);
      if (event.payload.mode === 'manage') {
        void refreshSessions();
      }
    });

    // Detect window label, apply dark mode, and show window
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      const win = getCurrentWebviewWindow();
      const label = win.label;
      windowLabelRef.current = label;
      setWindowLabel(label);
      // If this is the create-only window, set mode to create immediately
      if (label === 'connection-create') {
        setMode('create');
      }
      void win.center().then(async () => {
        await win.show();
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('apply_window_dark_mode', { windowLabel: win.label });
        } catch (e) {
          // Non-critical — window border stays light on failure
          console.warn('Failed to apply dark mode:', e);
        }
      });
    });

    // Add body class to override global min-width/min-height for this window
    document.body.classList.add('has-connection-window');

    return () => {
      document.body.classList.remove('has-connection-window');
      unlisten.then(fn => fn());
    };
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu]);

  async function refreshSessions() {
    setSelectedSessionId(null);
    try {
      setSessions(await listSessions());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionFormError(`加载连接列表失败：${message}`);
    }
  }

  const filteredSessions = useMemo(() => {
    const q = connectionSearchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) =>
      session.name.toLowerCase().includes(q)
      || session.host.toLowerCase().includes(q)
      || session.username.toLowerCase().includes(q),
    );
  }, [sessions, connectionSearchQuery]);

  function loadSessionToForm(session: Session) {
    setConnectionForm({
      name: session.name,
      host: session.host,
      username: session.username,
      port: String(session.port),
      password: session.auth.type === 'password' ? session.auth.secret_id : '',
      privateKeyPath: session.auth.type === 'private_key' ? session.auth.key_id : '',
      privateKeyPassphrase: session.auth.type === 'private_key' ? (session.auth.passphrase_secret_id ?? '') : '',
      keyboardInteractiveResponse: session.auth.type === 'keyboard_interactive' ? session.auth.response_secret_id : '',
      gssapiPrincipal: session.auth.type === 'gssapi' ? (session.auth.principal ?? '') : '',
    });
    setConnectionAuthMethod(
      session.auth.type === 'private_key' ? 'public_key' :
      session.auth.type === 'keyboard_interactive' ? 'keyboard_interactive' :
      session.auth.type === 'gssapi' ? 'gssapi' : 'password'
    );
    setConnectionFormError('');
    setMode('create');
  }

  function updateConnectionForm(field: keyof ConnectionFormState, value: string) {
    setConnectionForm((current) => ({ ...current, [field]: value }));
    if (connectionFormError) setConnectionFormError('');
  }

  function buildConnectionAuth(): AuthType {
    if (connectionAuthMethod === 'password') {
      return { type: 'password', secret_id: connectionForm.password.trim() };
    }
    if (connectionAuthMethod === 'public_key') {
      return {
        type: 'private_key',
        key_id: connectionForm.privateKeyPath.trim(),
        passphrase_secret_id: connectionForm.privateKeyPassphrase.trim() || null,
      };
    }
    if (connectionAuthMethod === 'keyboard_interactive') {
      return { type: 'keyboard_interactive', response_secret_id: connectionForm.keyboardInteractiveResponse.trim() };
    }
    return { type: 'gssapi', principal: connectionForm.gssapiPrincipal.trim() || null };
  }

  function validateConnectionForm(): string | null {
    const name = connectionForm.name.trim();
    const host = connectionForm.host.trim();
    const username = connectionForm.username.trim();
    const port = Number(connectionForm.port.trim() || '22');

    if (!name) return '连接名称不能为空';
    if (!host) return '主机地址不能为空';
    if (!username) return '用户名不能为空';
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return '端口必须是 1-65535 之间的整数';
    if (connectionAuthMethod === 'password' && !connectionForm.password.trim()) return '密码不能为空';
    if (connectionAuthMethod === 'public_key' && !connectionForm.privateKeyPath.trim()) return '私钥路径不能为空';
    if (connectionAuthMethod === 'keyboard_interactive' && !connectionForm.keyboardInteractiveResponse.trim()) {
      return '交互提示响应不能为空';
    }
    return null;
  }

  async function saveAndConnectConnection() {
    const error = validateConnectionForm();
    if (error) {
      setConnectionFormError(error);
      return;
    }

    const session: Session = {
      id: crypto.randomUUID(),
      name: connectionForm.name.trim(),
      group: 'Custom',
      host: connectionForm.host.trim(),
      port: Number(connectionForm.port.trim() || '22'),
      username: connectionForm.username.trim(),
      auth: buildConnectionAuth(),
      tags: ['custom', connectionAuthMethod],
      last_connected_at: null,
      reconnect: { enabled: true, max_attempts: 3, delay_ms: 1500 },
    };

    setIsSavingConnection(true);
    setConnectionFormError('');

    try {
      const nextSessions = await saveSession(session);
      setSessions(nextSessions);
      setConnectionForm(initialConnectionForm);
      setConnectionAuthMethod('password');
      setMode('manage');

      // Emit event to main window to connect this session
      await emitConnectSession(session);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setConnectionFormError(message);
    } finally {
      setIsSavingConnection(false);
    }
  }

  async function deleteConnectionSession(session: Session) {
    try {
      const nextSessions = await deleteSession(session.id);
      setSessions(nextSessions);
      setSelectedSessionId(null);
      setContextMenu(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionFormError(message);
    }
  }

  async function emitConnectSession(session: Session) {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('connection-window-connect-session', session);
      // Auto-close window after connecting
      await handleCloseWindow();
    } catch (e) {
      console.error('Failed to emit connect session event:', e);
    }
  }

  function handleRowContextMenu(e: React.MouseEvent, session: Session) {
    e.preventDefault();
    setSelectedSessionId(session.id);
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }

  function handleCopySessionInfo(session: Session) {
    const info = `${session.name}\t${session.host}\t${session.username}\t${session.port}`;
    void navigator.clipboard.writeText(info);
    setContextMenu(null);
  }

  async function handleCloseWindow() {
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      await win.close();
    } catch (e) {
      console.error('Failed to close window:', e);
    }
  }

  return (
    <div className="connection-window-root">
      {/* Custom draggable title bar */}
      <header className="connection-window-titlebar" data-tauri-drag-region>
        <span className="connection-window-title" data-tauri-drag-region>
          {windowLabel === 'connection-create' ? '新建连接' : (mode === 'create' ? '编辑连接' : '连接管理')} — PandaTerm
        </span>
        <button className="connection-window-titlebar-close" onClick={handleCloseWindow}>
          <X size={16} />
        </button>
      </header>

      <div className="connection-window-body">
        {mode === 'manage' ? (
          <div className="connection-manage-body">
            {/* Toolbar */}
            <div className="connection-manage-toolbar">
              <div className="connection-manage-toolbar-actions">
                <button className="connection-toolbar-btn" title="新建连接" onClick={() => void openConnectionWindow('create')}>
                  <Plus size={14} /><span>新建</span>
                </button>
                <button className="connection-toolbar-btn" title="编辑连接" disabled={!selectedSessionId}
                  onClick={() => { const s = sessions.find(s => s.id === selectedSessionId); if (s) loadSessionToForm(s); }}>
                  <Edit size={14} /><span>编辑</span>
                </button>
                <button className="connection-toolbar-btn danger" title="删除连接" disabled={!selectedSessionId}
                  onClick={() => { const s = sessions.find(s => s.id === selectedSessionId); if (s) void deleteConnectionSession(s); }}>
                  <Trash2 size={14} /><span>删除</span>
                </button>
              </div>
              <div className="connection-search-bar">
                <Search size={15} />
                <input
                  value={connectionSearchQuery}
                  placeholder="搜索名称、主机或用户名..."
                  onChange={(event) => setConnectionSearchQuery(event.target.value)}
                />
                {connectionSearchQuery && (
                  <button className="connection-search-clear" onClick={() => setConnectionSearchQuery('')}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="connection-table-wrap">
              {/* Local terminal card */}
              <div
                className={`connection-local-card ${selectedSessionId === localSession.id ? 'selected' : ''}`}
                onClick={() => setSelectedSessionId(localSession.id)}
                onDoubleClick={() => void emitConnectSession(localSession)}
                onContextMenu={(e) => handleRowContextMenu(e, localSession)}
              >
                <Monitor size={18} className="connection-local-icon" />
                <span className="connection-local-name">本地终端</span>
                <span className="connection-local-desc">在本机打开一个终端</span>
              </div>

              {filteredSessions.length > 0 ? (
                <table className="connection-table">
                  <thead>
                    <tr>
                      <th className="conn-th-name">名称</th>
                      <th className="conn-th-host">主机</th>
                      <th className="conn-th-user">用户名</th>
                      <th className="conn-th-protocol">协议</th>
                      <th className="conn-th-port">端口</th>
                      <th className="conn-th-desc">说明</th>
                      <th className="conn-th-time">修改时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSessions.map((session) => (
                      <tr
                        key={session.id}
                        className={selectedSessionId === session.id ? 'connection-row selected' : 'connection-row'}
                        onClick={() => setSelectedSessionId(session.id)}
                        onDoubleClick={() => void emitConnectSession(session)}
                        onContextMenu={(e) => handleRowContextMenu(e, session)}
                      >
                        <td className="conn-td-name">{session.name}</td>
                        <td className="conn-td-host">{session.host}</td>
                        <td className="conn-td-user">{session.username}</td>
                        <td className="conn-td-protocol">SSH</td>
                        <td className="conn-td-port">{session.port}</td>
                        <td className="conn-td-desc">{session.group}</td>
                        <td className="conn-td-time">{session.last_connected_at ? new Date(session.last_connected_at).toLocaleString('zh-CN') : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : sessions.length > 0 ? (
                <div className="connection-empty-state">
                  <Search size={28} />
                  <strong>没有匹配的连接</strong>
                  <span>尝试更换搜索关键词。</span>
                </div>
              ) : (
                <div className="connection-empty-state">
                  <Server size={28} />
                  <strong>暂无已保存连接</strong>
                  <span>点击上方按钮新建一个连接。</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <footer className="connection-manage-footer">
              <label className="connection-show-on-start">
                <input type="checkbox" />
                <span>启动时显示此对话框</span>
              </label>
              <div className="connection-manage-footer-actions">
                <button className="connection-secondary-action" onClick={handleCloseWindow}>
                  关闭
                </button>
                <button className="connection-card-action" disabled={!selectedSessionId}
                  onClick={() => {
                    if (selectedSessionId === localSession.id) {
                      void emitConnectSession(localSession);
                    } else {
                      const s = sessions.find(s => s.id === selectedSessionId);
                      if (s) void emitConnectSession(s);
                    }
                  }}>
                  连接
                </button>
              </div>
            </footer>
          </div>
        ) : (
          <div className="connection-panel-body">
            <div className="connection-panel-description">
              这里会把表单写入连接配置，并立即打开对应终端。
            </div>
            {connectionFormError && <div className="connection-form-error">{connectionFormError}</div>}
            <div className="connection-form-grid">
              <label>
                <span>连接名称</span>
                <input
                  value={connectionForm.name}
                  placeholder="例如：测试服务器"
                  onChange={(event) => updateConnectionForm('name', event.target.value)}
                />
              </label>
              <label>
                <span>主机地址</span>
                <input
                  value={connectionForm.host}
                  placeholder="192.168.1.10 或 example.com"
                  onChange={(event) => updateConnectionForm('host', event.target.value)}
                />
              </label>
              <label>
                <span>用户名</span>
                <input
                  value={connectionForm.username}
                  placeholder="root"
                  onChange={(event) => updateConnectionForm('username', event.target.value)}
                />
              </label>
              <label>
                <span>端口</span>
                <input
                  value={connectionForm.port}
                  placeholder="22"
                  inputMode="numeric"
                  onChange={(event) => updateConnectionForm('port', event.target.value)}
                />
              </label>
              <label className="connection-form-wide">
                <span>认证方式</span>
                <select
                  value={connectionAuthMethod}
                  onChange={(event) => {
                    setConnectionAuthMethod(event.target.value as ConnectionAuthMethod);
                    setConnectionFormError('');
                  }}
                >
                  <option value="password">Password</option>
                  <option value="public_key">Public Key</option>
                  <option value="keyboard_interactive">Keyboard Interactive</option>
                  <option value="gssapi">GSSAPI</option>
                </select>
              </label>

              {connectionAuthMethod === 'password' && (
                <div className="connection-form-wide connection-auth-fields">
                  <label>
                    <span>密码</span>
                    <input
                      type="password"
                      value={connectionForm.password}
                      placeholder="输入 SSH 登录密码"
                      onChange={(event) => updateConnectionForm('password', event.target.value)}
                    />
                  </label>
                </div>
              )}

              {connectionAuthMethod === 'public_key' && (
                <div className="connection-form-wide connection-auth-fields">
                  <label>
                    <span>私钥路径</span>
                    <input
                      value={connectionForm.privateKeyPath}
                      placeholder="例如：C:\\Users\\you\\.ssh\\id_rsa"
                      onChange={(event) => updateConnectionForm('privateKeyPath', event.target.value)}
                    />
                  </label>
                  <label>
                    <span>私钥口令</span>
                    <input
                      type="password"
                      value={connectionForm.privateKeyPassphrase}
                      placeholder="没有口令可留空"
                      onChange={(event) => updateConnectionForm('privateKeyPassphrase', event.target.value)}
                    />
                  </label>
                </div>
              )}

              {connectionAuthMethod === 'keyboard_interactive' && (
                <div className="connection-form-wide connection-auth-fields">
                  <label>
                    <span>交互提示响应</span>
                    <input
                      type="password"
                      value={connectionForm.keyboardInteractiveResponse}
                      placeholder="用于 Keyboard Interactive 的默认响应"
                      onChange={(event) => updateConnectionForm('keyboardInteractiveResponse', event.target.value)}
                    />
                  </label>
                </div>
              )}

              {connectionAuthMethod === 'gssapi' && (
                <div className="connection-form-wide connection-auth-fields">
                  <label>
                    <span>GSSAPI Principal</span>
                    <input
                      value={connectionForm.gssapiPrincipal}
                      placeholder="例如：user@REALM.COM，可留空使用当前身份"
                      onChange={(event) => updateConnectionForm('gssapiPrincipal', event.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
            <footer className="connection-panel-actions">
              <button className="connection-secondary-action" onClick={() => {
                if (windowLabel === 'connection-create') {
                  void handleCloseWindow();
                } else {
                  setConnectionForm(initialConnectionForm);
                  setConnectionAuthMethod('password');
                  setConnectionFormError('');
                  setMode('manage');
                }
              }}>
                取消
              </button>
              <button className="connection-primary-action" onClick={() => void saveAndConnectConnection()} disabled={isSavingConnection}>
                {isSavingConnection ? '保存中...' : '保存并连接'}
              </button>
            </footer>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="connection-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className="connection-context-item" onClick={() => { void emitConnectSession(contextMenu.session); setContextMenu(null); }}>
            <Server size={14} /><span>连接</span>
          </button>
          {contextMenu.session.id !== localSession.id && (
            <button className="connection-context-item" onClick={() => { loadSessionToForm(contextMenu.session); setContextMenu(null); }}>
              <Edit size={14} /><span>编辑</span>
            </button>
          )}
          <button className="connection-context-item" onClick={() => { handleCopySessionInfo(contextMenu.session); setContextMenu(null); }}>
            <Copy size={14} /><span>复制信息</span>
          </button>
          {contextMenu.session.id !== localSession.id && (
            <>
              <div className="connection-context-divider" />
              <button className="connection-context-item danger" onClick={() => { void deleteConnectionSession(contextMenu.session); }}>
                <Trash2 size={14} /><span>删除</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
