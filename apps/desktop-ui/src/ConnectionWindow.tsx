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
  ShieldCheck,
  LockKeyhole,
} from 'lucide-react';
import {
  listSessions,
  saveSession,
  deleteSession,
  reorderSessions,
  openConnectionWindow,
  getCredentialStatus,
  unlockCredentials,
  lockCredentials,
  setCredentialProtection,
  writeClipboardText,
} from './api';
import type { CredentialStatus, Session, AuthType } from './api';
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

const initialWindowMode: ConnectionWindowMode = new URLSearchParams(window.location.search).get('connectionMode') === 'create'
  ? 'create'
  : 'manage';
const initialWindowLabel = initialWindowMode === 'create' ? 'connection-create' : 'connection-panel';

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
  const windowLabelRef = useRef<string>(initialWindowLabel);
  const [windowLabel, setWindowLabel] = useState<string>(initialWindowLabel);
  const [mode, setMode] = useState<ConnectionWindowMode>(initialWindowMode);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [connectionSearchQuery, setConnectionSearchQuery] = useState('');
  const [connectionAuthMethod, setConnectionAuthMethod] = useState<ConnectionAuthMethod>('password');
  const [connectionForm, setConnectionForm] = useState<ConnectionFormState>(initialConnectionForm);
  const [connectionFormError, setConnectionFormError] = useState('');
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // === 连接列表行拖拽：pointer-events 实现（参考 App.tsx 终端 tab 拖拽） ===
  // 注意：早期版本用的是 HTML5 原生 `draggable` + onDragStart/onDragOver/onDrop。
  // 在 Tauri 的 webview 中，这种原生拖拽会显示"禁止光标"且根本拖不动
  // （和文件拖放 forbidden-cursor 是同一类 Tauri/webview 行为问题）。
  // 因此这里改成和终端一致的 pointer-based 拖拽，自行管理拖动与放置，
  // 不再依赖浏览器的原生 drag-and-drop。改动前请记得此坑，勿再改回 draggable。
  const CONNECTION_DRAG_THRESHOLD = 12;
  // targetId 存进 ref 而非仅 state：onUp 闭包读的是拖拽开始那次渲染的 dragOverId，
  // 永远拿不到 onMove 后续更新的最新值，因此放置目标必须放在 ref 上。
  const connectionDragRef = useRef<{ sourceId: string; startX: number; startY: number; active: boolean; targetId: string | null } | null>(null);
  // 标记本次 pointerup 之前是否真的发生了拖拽，用于抑制随后的 onClick（避免误选中）。
  const connectionDidDragRef = useRef(false);

  // === 表头列宽拖拽（参考 App.tsx 终端面板分割线 resize 的 pointer 写法） ===
  // 各列宽度以百分比保存在 state，拖动表头右缘手柄时调整"该列 + 右邻列"（总和不变），
  // 配合 CSS `table-layout: fixed` 让百分比列宽严格生效。勿用 HTML5 draggable（Tauri 下禁止光标）。
  type ConnColumnKey = 'index' | 'name' | 'host' | 'user' | 'protocol' | 'port';
  const CONN_COLUMN_ORDER: ConnColumnKey[] = ['index', 'name', 'host', 'user', 'protocol', 'port'];
  const CONN_COLUMN_DEFAULT_WIDTHS: Record<ConnColumnKey, number> = {
    index: 6, name: 36, host: 19, user: 16, protocol: 10, port: 13,
  };
  const CONN_COLUMN_WIDTHS_KEY = 'pandaterm.connColumnWidths';
  // 列宽属于 UI 偏好，用 localStorage 持久化，重开窗口/刷新后无需重新拖动。
  function loadConnColumnWidths(): Record<ConnColumnKey, number> {
    try {
      const raw = localStorage.getItem(CONN_COLUMN_WIDTHS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<ConnColumnKey, number>>;
        const merged = { ...CONN_COLUMN_DEFAULT_WIDTHS };
        for (const key of CONN_COLUMN_ORDER) {
          const v = parsed[key];
          if (typeof v === 'number' && v > 0) merged[key] = v;
        }
        return merged;
      }
    } catch {
      // 忽略损坏的存储，回落到默认列宽
    }
    return { ...CONN_COLUMN_DEFAULT_WIDTHS };
  }
  const [connColumnWidths, setConnColumnWidths] = useState<Record<ConnColumnKey, number>>(loadConnColumnWidths);
  // ref 持有最新列宽，供 onUp 闭包读取并写入 localStorage（避免读到过期 state）。
  const connColumnWidthsRef = useRef(connColumnWidths);
  const connTableRef = useRef<HTMLTableElement | null>(null);
  const connColDragRef = useRef<{ col: ConnColumnKey; startX: number; start: Record<ConnColumnKey, number> } | null>(null);

  function startConnColResize(col: ConnColumnKey, event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    connColDragRef.current = { col, startX: event.clientX, start: { ...connColumnWidths } };
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = connColDragRef.current;
      const tableEl = connTableRef.current;
      if (!drag || !tableEl) return;
      const tableWidth = tableEl.getBoundingClientRect().width;
      if (tableWidth <= 0) return;
      const deltaPct = ((moveEvent.clientX - drag.startX) / tableWidth) * 100;
      const idx = CONN_COLUMN_ORDER.indexOf(drag.col);
      const rightCol = CONN_COLUMN_ORDER[idx + 1];
      const MIN = 4;
      setConnColumnWidths((prev) => {
        const next = { ...prev };
        let left = drag.start[drag.col] + deltaPct;
        if (rightCol) {
          const startTotal = drag.start[drag.col] + drag.start[rightCol];
          let right = drag.start[rightCol] - deltaPct;
          if (left < MIN && right > MIN) { left = MIN; right = startTotal - MIN; }
          else if (right < MIN && left > MIN) { right = MIN; left = startTotal - MIN; }
          else if (left < MIN && right < MIN) { left = MIN; right = MIN; }
          next[rightCol] = right;
        }
        if (left < MIN) left = MIN;
        next[drag.col] = left;
        connColumnWidthsRef.current = next;
        return next;
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      connColDragRef.current = null;
      // 松手时一次性持久化最新列宽（拖动中已同步到 ref），重开后仍能恢复。
      try {
        localStorage.setItem(CONN_COLUMN_WIDTHS_KEY, JSON.stringify(connColumnWidthsRef.current));
      } catch {
        // 忽略存储失败（如隐私模式）
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  useEffect(() => {
    if (initialWindowMode === 'manage') {
      void refreshSessions();
    }
    void getCredentialStatus().then((status) => {
      setCredentialStatus(status);
      if (status.error) setConnectionFormError(status.error);
    }).catch(() => setCredentialStatus(null));

    // Listen for mode change events — only accept events intended for THIS window.
    // Each event payload should specify a target label so windows don't interfere.
    const unlistenMode = listen<{ mode: ConnectionWindowMode; target: string }>('connection-window-set-mode', (event) => {
      // Only react if the event is targeted at this window's label
      if (event.payload.target !== windowLabelRef.current) return;
      // connection-create window only shows create mode — ignore manage requests
      if (windowLabelRef.current === 'connection-create' && event.payload.mode === 'manage') return;
      setMode(event.payload.mode);
      if (event.payload.mode === 'manage') {
        void refreshSessions();
      }
    });

    // Keep the list in sync when sessions change in another connection window
    // (e.g. a connection created/deleted in the separate "新建连接" window).
    const unlistenChanges = listen('sessions-changed', () => {
      if (windowLabelRef.current === 'connection-panel') {
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
      void win.show().then(async () => {
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
      unlistenMode.then(fn => fn());
      unlistenChanges.then(fn => fn());
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
    setEditingId(session.id);
    setConnectionForm({
      name: session.name,
      host: session.host,
      username: session.username,
      port: String(session.port),
      password: '',
      privateKeyPath: session.auth.type === 'private_key' ? session.auth.key_id : '',
      privateKeyPassphrase: '',
      keyboardInteractiveResponse: '',
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
    const existing = editingId ? sessions.find((session) => session.id === editingId) : undefined;
    const keepsExistingPassword = existing?.auth.type === 'password';
    const keepsExistingInteractive = existing?.auth.type === 'keyboard_interactive';
    if (connectionAuthMethod === 'password' && !connectionForm.password.trim() && !keepsExistingPassword) return '密码不能为空';
    if (connectionAuthMethod === 'public_key' && !connectionForm.privateKeyPath.trim()) return '私钥路径不能为空';
    if (connectionAuthMethod === 'keyboard_interactive' && !connectionForm.keyboardInteractiveResponse.trim() && !keepsExistingInteractive) {
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

    const original = editingId ? sessions.find((s) => s.id === editingId) : undefined;

    const session: Session = {
      id: editingId ?? crypto.randomUUID(),
      name: connectionForm.name.trim(),
      group: original?.group ?? 'Custom',
      host: connectionForm.host.trim(),
      port: Number(connectionForm.port.trim() || '22'),
      username: connectionForm.username.trim(),
      auth: buildConnectionAuth(),
      tags: original?.tags ?? ['custom', connectionAuthMethod],
      last_connected_at: original?.last_connected_at ?? null,
      reconnect: original?.reconnect ?? { enabled: true, max_attempts: 3, delay_ms: 1500 },
    };

    setIsSavingConnection(true);
    setConnectionFormError('');

    try {
      const secret = connectionAuthMethod === 'password'
        ? connectionForm.password
        : connectionAuthMethod === 'keyboard_interactive'
          ? connectionForm.keyboardInteractiveResponse
          : null;
      const passphrase = connectionAuthMethod === 'public_key'
        ? connectionForm.privateKeyPassphrase
        : null;
      const nextSessions = await saveSession(session, secret, passphrase);
      setSessions(nextSessions);
      setConnectionForm(initialConnectionForm);
      setConnectionAuthMethod('password');
      setEditingId(null);
      setMode('manage');

      // Notify other open connection windows (e.g. the manager) to refresh
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('sessions-changed');
      } catch (e) { /* non-critical */ }

      // Only auto-connect when creating a brand-new connection, not when editing.
      // Use the backend-returned session so no plaintext credential enters the event bus.
      if (!original) {
        const savedSession = nextSessions.find((item) => item.id === session.id);
        if (!savedSession) throw new Error('连接已保存，但后端未返回对应会话');
        await emitConnectSession(savedSession);
      }
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
      // Notify other open connection windows to refresh their lists
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('sessions-changed');
      } catch (e) { /* non-critical */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionFormError(message);
    }
  }

  async function handleReorderSessions(sourceId: string, targetId: string) {
    if (!sourceId || sourceId === targetId) return;
    const ids = sessions.map((s) => s.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;

    // Reorder the full (unfiltered) list, then persist the new order.
    const nextIds = [...ids];
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0]);
    const reordered = sessions
      .slice()
      .sort((a, b) => nextIds.indexOf(a.id) - nextIds.indexOf(b.id));
    setSessions(reordered);
    setDraggingId(null);

    try {
      const next = await reorderSessions(nextIds);
      setSessions(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionFormError(`保存排序失败：${message}`);
    }
  }

  // 基于 pointer events 的连接行拖拽（参考 App.tsx 终端拖拽写法）。
  // 启动前若处于搜索过滤状态则禁用排序（行顺序已与全量列表不一致）。
  function startConnectionRowDrag(session: Session, event: React.PointerEvent) {
    if (connectionSearchQuery) return;
    if (event.button !== 0) return;

    connectionDragRef.current = { sourceId: session.id, startX: event.clientX, startY: event.clientY, active: false, targetId: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const drag = connectionDragRef.current;
      if (!drag) return;
      const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
      // 未超过阈值前不激活，保证普通点击/双击不受影响。
      if (!drag.active && distance < CONNECTION_DRAG_THRESHOLD) return;
      if (!drag.active) {
        drag.active = true;
        setDraggingId(drag.sourceId);
        document.body.classList.add('connection-reordering');
      }
      // 通过坐标命中当前悬停的行，作为放置目标。同时写入 ref（供 onUp 读取最新值）。
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const row = el?.closest('[data-conn-row]') as HTMLElement | null;
      const targetId = row?.dataset.connRow ?? null;
      drag.targetId = targetId !== drag.sourceId ? targetId : null;
      setDragOverId(drag.targetId);
    };

    const onUp = () => {
      const drag = connectionDragRef.current;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('connection-reordering');
      if (drag?.active) {
        // 标记发生了拖拽，抑制接踵而至的 onClick，避免误选中。
        connectionDidDragRef.current = true;
        setTimeout(() => { connectionDidDragRef.current = false; }, 0);
        // 注意：必须从 ref 读 targetId，闭包里的 dragOverId 是旧渲染值（恒为 null）。
        const target = drag.targetId;
        setDraggingId(null);
        setDragOverId(null);
        if (target && target !== drag.sourceId) {
          void handleReorderSessions(drag.sourceId, target);
        }
      }
      connectionDragRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
    void writeClipboardText(info);
    setContextMenu(null);
  }

  async function handleCredentialSecurity() {
    try {
      if (!credentialStatus || credentialStatus.mode === 'dpapi') {
        const password = window.prompt('设置 Master Password（至少 8 个字符）：');
        if (!password) return;
        const confirmation = window.prompt('再次输入 Master Password：');
        if (password !== confirmation) {
          setConnectionFormError('两次输入的 Master Password 不一致');
          return;
        }
        setCredentialStatus(await setCredentialProtection('master_password', password));
        setConnectionFormError('');
        return;
      }

      if (credentialStatus.locked) {
        const password = window.prompt('输入 Master Password 解锁凭据：');
        if (!password) return;
        setCredentialStatus(await unlockCredentials(password));
        setConnectionFormError('');
        return;
      }

      if (window.confirm('切换回 Windows 用户保护？凭据将绑定当前 Windows 用户，不能跨电脑解密。')) {
        setCredentialStatus(await setCredentialProtection('dpapi'));
        setConnectionFormError('');
      }
    } catch (error) {
      setConnectionFormError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLockCredentials() {
    try {
      await lockCredentials();
      setCredentialStatus(await getCredentialStatus());
    } catch (error) {
      setConnectionFormError(error instanceof Error ? error.message : String(error));
    }
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
                <button
                  className="connection-toolbar-btn"
                  title={credentialStatus?.error
                    ? credentialStatus.error
                    : credentialStatus?.mode === 'master_password'
                      ? (credentialStatus.locked ? '输入 Master Password 解锁' : '切换回 Windows 用户保护')
                      : '启用 Master Password，允许安全迁移配置'}
                  disabled={Boolean(credentialStatus?.error)}
                  onClick={() => void handleCredentialSecurity()}
                >
                  <ShieldCheck size={14} />
                  <span>{credentialStatus?.error
                    ? '凭据仓库异常'
                    : credentialStatus?.mode === 'master_password'
                      ? (credentialStatus.locked ? '凭据已锁定' : 'Master Password')
                      : 'Windows 保护'}</span>
                </button>
                {credentialStatus?.mode === 'master_password' && !credentialStatus.locked && (
                  <button className="connection-toolbar-btn" title="立即锁定凭据" onClick={() => void handleLockCredentials()}>
                    <LockKeyhole size={14} /><span>锁定</span>
                  </button>
                )}
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
            {connectionFormError && <div className="connection-form-error">{connectionFormError}</div>}

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
                <table className="connection-table" ref={connTableRef}>
                  <thead>
                    <tr>
                      <th className="conn-th-index" style={{ width: `${connColumnWidths.index}%` }}>
                        #
                        <span className="conn-col-resizer" onPointerDown={(e) => startConnColResize('index', e)} />
                      </th>
                      <th className="conn-th-name" style={{ width: `${connColumnWidths.name}%` }}>
                        名称
                        <span className="conn-col-resizer" onPointerDown={(e) => startConnColResize('name', e)} />
                      </th>
                      <th className="conn-th-host" style={{ width: `${connColumnWidths.host}%` }}>
                        主机
                        <span className="conn-col-resizer" onPointerDown={(e) => startConnColResize('host', e)} />
                      </th>
                      <th className="conn-th-user" style={{ width: `${connColumnWidths.user}%` }}>
                        用户名
                        <span className="conn-col-resizer" onPointerDown={(e) => startConnColResize('user', e)} />
                      </th>
                      <th className="conn-th-protocol" style={{ width: `${connColumnWidths.protocol}%` }}>
                        协议
                        <span className="conn-col-resizer" onPointerDown={(e) => startConnColResize('protocol', e)} />
                      </th>
                      <th className="conn-th-port" style={{ width: `${connColumnWidths.port}%` }}>
                        端口
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSessions.map((session, rowIndex) => (
                      <tr
                        key={session.id}
                        data-conn-row={session.id}
                        className={`connection-row${selectedSessionId === session.id ? ' selected' : ''}${draggingId === session.id ? ' dragging' : ''}${dragOverId === session.id ? ' drop-target' : ''}`}
                        onClick={(event) => {
                          // 若刚刚发生过拖拽，则吞掉这次点击，避免误选中目标行。
                          if (connectionDidDragRef.current) return;
                          setSelectedSessionId(session.id);
                        }}
                        onDoubleClick={() => void emitConnectSession(session)}
                        onContextMenu={(e) => handleRowContextMenu(e, session)}
                        onPointerDown={(event) => startConnectionRowDrag(session, event)}
                      >
                        <td className="conn-td-index">{rowIndex + 1}</td>
                        <td className="conn-td-name">{session.name}</td>
                        <td className="conn-td-host">{session.host}</td>
                        <td className="conn-td-user">{session.username}</td>
                        <td className="conn-td-protocol">SSH</td>
                        <td className="conn-td-port">{session.port}</td>
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
                      placeholder={editingId ? '留空则保留已保存密码' : '输入 SSH 登录密码'}
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
                      placeholder={editingId ? '留空则保留已保存口令' : '没有口令可留空'}
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
                      placeholder={editingId ? '留空则保留已保存响应' : '用于 Keyboard Interactive 的默认响应'}
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
                  setEditingId(null);
                  setMode('manage');
                }
              }}>
                取消
              </button>
              <button className="connection-primary-action" onClick={() => void saveAndConnectConnection()} disabled={isSavingConnection}>
                {isSavingConnection ? '保存中...' : (editingId ? '保存' : '保存并连接')}
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
