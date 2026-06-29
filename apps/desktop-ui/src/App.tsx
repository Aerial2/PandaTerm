import { listen } from '@tauri-apps/api/event';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  File,
  FolderOpen,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  connectSession,
  disconnectSession,
  getLocalTerminalProfile,
  listLocalDirectory,
  deleteSession,
  listSessions,
  readLocalFilePreview,
  resizeLocalTerminal,
  resizeTerminal,
  sendLocalTerminalInput,
  startLocalTerminal,
  stopLocalTerminal,
  terminalWrite,
  saveSession,
} from './api';
import type { LocalDirectoryEntry, LocalDirectoryListing, LocalFilePreview, LocalTerminalProfile, Session, TerminalOutputEvent } from './api';

type TabKind = 'terminal' | 'sftp';

type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected' | 'closed';

type TerminalSplitDirection = 'horizontal' | 'vertical';
type TerminalDropSide = 'left' | 'right' | 'top' | 'bottom';
type TerminalDragOperation = 'none' | 'reorder' | 'split' | 'replace' | 'workspace';
type TerminalReorderPlacement = 'before' | 'after';

type TerminalDragState = {
  tabId: string;
  operation: TerminalDragOperation;
  isOverWorkspace: boolean;
  targetPaneId: string | null;
  targetTabId: string | null;
  side: TerminalDropSide | null;
  reorderPlacement: TerminalReorderPlacement | null;
  ghostX: number;
  ghostY: number;
};

type TerminalPointerDragCandidate = {
  tabId: string;
  startX: number;
  startY: number;
  active: boolean;
  previousActiveTabId: string | null;
};

type TerminalSplitResizeCandidate = {
  splitId: string;
  direction: TerminalSplitDirection;
  startX: number;
  startY: number;
  startRatio: number;
  containerWidth: number;
  containerHeight: number;
};

const TERMINAL_TAB_DRAG_THRESHOLD = 12;
const TERMINAL_PANE_EDGE_DROP_RATIO = 0.25;
const TERMINAL_SPLIT_RATIO_MIN = 0.15;
const TERMINAL_SPLIT_RATIO_MAX = 0.85;

type TerminalLayoutNode =
  | { type: 'leaf'; tabId: string; tabIds?: string[] }
  | { type: 'split'; id: string; direction: TerminalSplitDirection; ratio: number; first: TerminalLayoutNode; second: TerminalLayoutNode };

type TerminalActivityEntry = {
  time: string;
  level: 'info' | 'warn' | 'error';
  text: string;
};

type WorkspaceTab = {
  id: string;
  kind: TabKind;
  session: Session;
  title: string;
  terminalId: string;
  status: TerminalStatus;
  output: string[];
  statusMessage?: string;
  closedByUser: boolean;
  reconnectAttempts: number;
  activityLog: TerminalActivityEntry[];
  layout?: TerminalLayoutNode;
  activePaneId?: string;
  parentTabId?: string;
};

type ResourceFile = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: string;
  sizeBytes: number;
  modifiedTime: string;
};

type ResourceSortKey = 'name' | 'size' | 'modifiedTime';
type ResourceBottomTab = 'transfer' | 'log';
type ConnectionPanelMode = 'create' | 'manage' | null;
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

const oneDarkProTerminalTheme: ITheme = {
  background: '#23272e',
  foreground: '#e6e6e6',
  cursor: '#61afef',
  selectionBackground: 'rgba(97, 175, 239, 0.15)',
  black: '#23272e',
  blue: '#61afef',
  cyan: '#56b6c2',
  green: '#98c379',
  magenta: '#c678dd',
  red: '#e06c75',
  white: '#e6e6e6',
  yellow: '#e5c07b',
  brightBlack: '#6c7086',
  brightBlue: '#61afef',
  brightCyan: '#56b6c2',
  brightGreen: '#98c379',
  brightMagenta: '#c678dd',
  brightRed: '#e06c75',
  brightWhite: '#e6e6e6',
  brightYellow: '#e5c07b',
};

const localSession: Session = {
  id: 'local-system',
  name: '本地系统',
  group: 'Local',
  host: 'localhost',
  port: 0,
  username: 'local',
  auth: { type: 'agent' },
  tags: ['local', 'system'],
  last_connected_at: null,
  reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
};

const isFallbackMac = navigator.userAgent.toLowerCase().includes('mac');

const fallbackLocalTerminalProfile: LocalTerminalProfile = {
  terminal_id: '',
  os: isFallbackMac ? 'macos' : 'windows',
  shell_name: isFallbackMac ? 'zsh' : 'PowerShell',
  cwd: isFallbackMac ? '/Users' : 'E:\\Project\\Rust\\PandaTerm',
  prompt: isFallbackMac ? '/Users $' : 'PS E:\\Project\\Rust\\PandaTerm>',
  banner: [],
};

function formatFileSize(size: number) {
  if (size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatModifiedTime(modifiedMs?: number | null) {
  if (!modifiedMs) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(modifiedMs));
}

function toResourceFile(entry: LocalDirectoryEntry): ResourceFile {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.entry_type,
    size: entry.entry_type === 'directory' ? '-' : formatFileSize(entry.size),
    sizeBytes: entry.size,
    modifiedTime: formatModifiedTime(entry.modified_ms),
  };
}

const resourceLogs = [
  '本地资源视图已接入真实目录读取。',
  '当前已支持目录刷新、路径跳转、上级目录和双击进入目录。',
  '文件预览、编辑、复制、移动和删除将按后续步骤接入。',
];

function compareResource(a: ResourceFile, b: ResourceFile, key: ResourceSortKey) {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  if (key === 'size') return a.sizeBytes - b.sizeBytes;
  return a[key].localeCompare(b[key], 'zh-Hans-CN', { numeric: true });
}

function clampPanelWidth(width: number) {
  return Math.min(68, Math.max(24, width));
}

function buildPathBreadcrumbs(path: string) {
  const normalized = path.trim();
  if (!normalized) return [];

  const windowsDriveMatch = normalized.match(/^([A-Za-z]:\\)(.*)$/);
  if (windowsDriveMatch) {
    const root = windowsDriveMatch[1];
    const segments = windowsDriveMatch[2].split('\\').filter(Boolean);
    const crumbs = [{ label: root, path: root }];
    let current = root;

    segments.forEach((segment) => {
      current = current.endsWith('\\') ? `${current}${segment}` : `${current}\\${segment}`;
      crumbs.push({ label: segment, path: current });
    });

    return crumbs;
  }

  const segments = normalized.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];

  segments.forEach((segment, index) => {
    crumbs.push({ label: segment, path: `/${segments.slice(0, index + 1).join('/')}` });
  });

  return crumbs;
}

type TerminalSizeSnapshot = {
  width: number;
  height: number;
  cols: number;
  rows: number;
};

const REMOTE_READY_MARKER = '__PANDATERM_REMOTE_READY__';

function isRemoteSessionReadyOutput(payload: string) {
  const normalized = payload.toLowerCase();
  return payload.includes(REMOTE_READY_MARKER)
    || normalized.includes('ssh shell started')
    || normalized.includes('last login')
    || normalized.includes('welcome')
    || normalized.includes('microsoft')
    || normalized.includes('ubuntu')
    || /[$#>]\s*$/.test(payload.trimEnd());
}

function stripRemoteReadyMarker(payload: string) {
  return payload
    .split(/\r?\n/)
    .filter((line) => !line.includes(REMOTE_READY_MARKER))
    .join('\r\n');
}

function isRemoteSessionFailureOutput(payload: string) {
  const normalized = payload.toLowerCase();
  return normalized.includes('permission denied')
    || normalized.includes('connection timed out')
    || normalized.includes('connection refused')
    || normalized.includes('no route to host')
    || normalized.includes('could not resolve hostname')
    || normalized.includes('[pandaterm ssh] failed')
    || normalized.includes('ssh tcp 连接失败')
    || normalized.includes('ssh 握手失败')
    || normalized.includes('ssh 认证失败')
    || normalized.includes('ssh shell 启动失败');
}

function createDefaultTerminalLayout(tabId: string): TerminalLayoutNode {
  return { type: 'leaf', tabId, tabIds: [tabId] };
}

function getLeafTabIds(node: Extract<TerminalLayoutNode, { type: 'leaf' }>): string[] {
  return node.tabIds?.length ? node.tabIds : [node.tabId];
}

function collectTerminalLayoutTabIds(node?: TerminalLayoutNode): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return getLeafTabIds(node);
  return [...collectTerminalLayoutTabIds(node.first), ...collectTerminalLayoutTabIds(node.second)];
}

function clampSplitRatio(value: number) {
  return Math.min(TERMINAL_SPLIT_RATIO_MAX, Math.max(TERMINAL_SPLIT_RATIO_MIN, value));
}

function updateTerminalSplitRatio(node: TerminalLayoutNode, splitId: string, ratio: number): TerminalLayoutNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, ratio: clampSplitRatio(ratio) };
  return {
    ...node,
    first: updateTerminalSplitRatio(node.first, splitId, ratio),
    second: updateTerminalSplitRatio(node.second, splitId, ratio),
  };
}

function dropSideToSplit(side: TerminalDropSide) {
  return {
    direction: side === 'left' || side === 'right' ? 'horizontal' as const : 'vertical' as const,
    placeBefore: side === 'left' || side === 'top',
  };
}

function insertTerminalPane(node: TerminalLayoutNode, targetTabId: string, droppedTabId: string, side: TerminalDropSide): TerminalLayoutNode {
  // Defensive: strip any existing reference to droppedTabId first so a tab can
  // never end up referenced by two leaves (which corrupts active-pane detection
  // and terminal host mapping).
  const base = removeTerminalPane(node, droppedTabId);
  const root: TerminalLayoutNode = base ?? { type: 'leaf', tabId: targetTabId, tabIds: [targetTabId] };
  return insertTerminalPaneLeaf(root, targetTabId, droppedTabId, side);
}

function removeTerminalPane(node: TerminalLayoutNode, targetTabId: string): TerminalLayoutNode | null {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(targetTabId)) return node;
    const remaining = tabIds.filter((id) => id !== targetTabId);
    if (remaining.length === 0) return null;
    const nextActive = node.tabId === targetTabId ? remaining[0] : node.tabId;
    return { ...node, tabId: nextActive, tabIds: remaining };
  }

  const first = removeTerminalPane(node.first, targetTabId);
  const second = removeTerminalPane(node.second, targetTabId);

  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function insertTerminalPaneLeaf(node: TerminalLayoutNode, targetTabId: string, droppedTabId: string, side: TerminalDropSide): TerminalLayoutNode {
  if (node.type === 'leaf') {
    if (!getLeafTabIds(node).includes(targetTabId)) return node;
    const { direction, placeBefore } = dropSideToSplit(side);
    const droppedLeaf: TerminalLayoutNode = { type: 'leaf', tabId: droppedTabId, tabIds: [droppedTabId] };
    const targetLeaf: TerminalLayoutNode = { ...node };
    return {
      type: 'split',
      id: `split:${crypto.randomUUID()}`,
      direction,
      ratio: 0.5,
      first: placeBefore ? droppedLeaf : targetLeaf,
      second: placeBefore ? targetLeaf : droppedLeaf,
    };
  }

  return {
    ...node,
    first: insertTerminalPaneLeaf(node.first, targetTabId, droppedTabId, side),
    second: insertTerminalPaneLeaf(node.second, targetTabId, droppedTabId, side),
  };
}


function addTerminalTabToPane(node: TerminalLayoutNode, paneTabId: string, nextTabId: string): TerminalLayoutNode {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(paneTabId)) return node;
    if (tabIds.includes(nextTabId)) return node; // dedupe: never duplicate a tab inside a pane
    return { ...node, tabId: nextTabId, tabIds: [...tabIds, nextTabId] };
  }

  return {
    ...node,
    first: addTerminalTabToPane(node.first, paneTabId, nextTabId),
    second: addTerminalTabToPane(node.second, paneTabId, nextTabId),
  };
}

function reorderPaneTabIds(node: TerminalLayoutNode, paneId: string, sourceTabId: string, targetTabId: string, placement: 'before' | 'after'): TerminalLayoutNode {
  if (node.type === 'leaf') {
    const tabIds = getLeafTabIds(node);
    if (!tabIds.includes(paneId) && node.tabId !== paneId) return node;
    if (!tabIds.includes(sourceTabId) || !tabIds.includes(targetTabId)) return node;
    const without = tabIds.filter((id) => id !== sourceTabId);
    const targetIdx = without.indexOf(targetTabId);
    if (targetIdx < 0) return node;
    const insertIdx = placement === 'before' ? targetIdx : targetIdx + 1;
    const next = [...without];
    next.splice(insertIdx, 0, sourceTabId);
    return { ...node, tabIds: next };
  }
  return {
    ...node,
    first: reorderPaneTabIds(node.first, paneId, sourceTabId, targetTabId, placement),
    second: reorderPaneTabIds(node.second, paneId, sourceTabId, targetTabId, placement),
  };
}

function activateTerminalPaneTab(node: TerminalLayoutNode, paneTabId: string): TerminalLayoutNode {
  if (node.type === 'leaf') {
    return getLeafTabIds(node).includes(paneTabId) ? { ...node, tabId: paneTabId } : node;
  }

  return {
    ...node,
    first: activateTerminalPaneTab(node.first, paneTabId),
    second: activateTerminalPaneTab(node.second, paneTabId),
  };
}

function removeTerminalTabFromPane(node: TerminalLayoutNode, paneTabId: string): { layout: TerminalLayoutNode | null; nextActivePaneId: string | null } {
  if (node.type === 'leaf') {
    const nextTabIds = getLeafTabIds(node).filter((tabId) => tabId !== paneTabId);
    if (nextTabIds.length === 0) return { layout: null, nextActivePaneId: null };
    const nextActivePaneId = node.tabId === paneTabId ? nextTabIds[0] : node.tabId;
    return { layout: { ...node, tabId: nextActivePaneId, tabIds: nextTabIds }, nextActivePaneId };
  }

  const first = removeTerminalTabFromPane(node.first, paneTabId);
  const second = removeTerminalTabFromPane(node.second, paneTabId);

  if (!first.layout) return { layout: second.layout, nextActivePaneId: second.nextActivePaneId };
  if (!second.layout) return { layout: first.layout, nextActivePaneId: first.nextActivePaneId };
  return { layout: { ...node, first: first.layout, second: second.layout }, nextActivePaneId: first.nextActivePaneId ?? second.nextActivePaneId };
}

function findTerminalWorkspaceOwner(tabs: WorkspaceTab[], paneTabId: string): WorkspaceTab | null {
  return tabs.find((tab) =>
    tab.kind === 'terminal'
    && !tab.parentTabId
    && collectTerminalLayoutTabIds(tab.layout ?? createDefaultTerminalLayout(tab.id)).includes(paneTabId),
  ) ?? null;
}

export function App() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [resourceCollapsed, setResourceCollapsed] = useState(false);
  const [resourcePanelWidth, setResourcePanelWidth] = useState(30);
  const [isResourceResizing, setIsResourceResizing] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [resourceFiles, setResourceFiles] = useState<ResourceFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileListError, setFileListError] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<LocalFilePreview | null>(null);
  const [filePreviewError, setFilePreviewError] = useState('');
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [sortKey, setSortKey] = useState<ResourceSortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [resourceBottomTab, setResourceBottomTab] = useState<ResourceBottomTab>('transfer');
  const [connectionPanelMode, setConnectionPanelMode] = useState<ConnectionPanelMode>(null);
  const [pendingPaneTabId, setPendingPaneTabId] = useState<string | null>(null);
  const [connectionAuthMethod, setConnectionAuthMethod] = useState<ConnectionAuthMethod>('password');
  const [connectionForm, setConnectionForm] = useState<ConnectionFormState>(initialConnectionForm);
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [openingConnection, setOpeningConnection] = useState<{ session: Session; startedAt: number; seconds: number } | null>(null);
  const [connectionFormError, setConnectionFormError] = useState('');
  const [connectionSearchQuery, setConnectionSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState('当前上下文：本地系统');
  const [localTerminalProfile, setLocalTerminalProfile] = useState<LocalTerminalProfile>(fallbackLocalTerminalProfile);
  const [terminalDragState, setTerminalDragState] = useState<TerminalDragState | null>(null);
  const terminalsRef = useRef<Map<string, Terminal>>(new Map());
  const terminalDataDisposablesRef = useRef<Map<string, { dispose: () => void }>>(new Map());
  const terminalResizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const terminalSizeCacheRef = useRef<Map<string, TerminalSizeSnapshot>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const terminalHostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalPaneRefs = useRef<Map<string, HTMLElement>>(new Map());
  const workspaceTabRefs = useRef<Map<string, HTMLElement>>(new Map());
  const terminalWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceTabsRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<WorkspaceTab | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const activePaneIdRef = useRef<string | null>(null);
  const terminalDragStateRef = useRef<TerminalDragState | null>(null);
  const terminalPointerDragRef = useRef<TerminalPointerDragCandidate | null>(null);
  const terminalSplitResizeRef = useRef<TerminalSplitResizeCandidate | null>(null);
  const paneTabElRefs = useRef<Map<string, HTMLElement>>(new Map());
  const tabsRef = useRef<WorkspaceTab[]>([]);
  // Track which terminal_ids have been started on the backend to avoid double-start
  const startedTerminalsRef = useRef<Set<string>>(new Set());
  // Map backend terminal_id → tab id, set immediately when startLocalTerminal resolves.
  // Bridges the gap between PTY output arriving and setTabs flushing the real terminalId.
  const terminalIdToTabIdRef = useRef<Map<string, string>>(new Map());
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const currentPathRef = useRef('');
  const resourceFilesRef = useRef<ResourceFile[]>([]);

  function getTerminalViewportSize(tabId: string) {
    const host = terminalHostsRef.current.get(tabId);
    if (!host) return { width: 0, height: 0 };
    const rect = host.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function fitTerminalIfNeeded(tabId: string, options: { force?: boolean } = {}) {
    const terminal = terminalsRef.current.get(tabId);
    const fitAddon = fitAddonsRef.current.get(tabId);
    if (!terminal || !fitAddon) return;

    const { width, height } = getTerminalViewportSize(tabId);
    if (width <= 0 || height <= 0) return;

    const previous = terminalSizeCacheRef.current.get(tabId);
    if (!options.force && previous?.width === width && previous?.height === height) {
      return;
    }

    fitAddon.fit();

    const nextSnapshot: TerminalSizeSnapshot = {
      width,
      height,
      cols: terminal.cols,
      rows: terminal.rows,
    };
    terminalSizeCacheRef.current.set(tabId, nextSnapshot);

    if (previous?.cols === terminal.cols && previous?.rows === terminal.rows) return;

    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab?.terminalId) return;
    if (tab.session.id === localSession.id) {
      void resizeLocalTerminal(tab.terminalId, terminal.cols, terminal.rows);
    } else {
      void resizeTerminal(tab.terminalId, terminal.cols, terminal.rows);
    }
  }

  function scheduleTerminalSettledFit(tabId: string) {
    requestAnimationFrame(() => {
      fitTerminalIfNeeded(tabId, { force: true });
      window.setTimeout(() => fitTerminalIfNeeded(tabId), 50);
      window.setTimeout(() => fitTerminalIfNeeded(tabId), 120);
    });
  }

  function scheduleVisibleTerminalFits(options: { force?: boolean } = {}) {
    const tabIds = visibleTerminalPaneIds.length > 0
      ? visibleTerminalPaneIds
      : tabsRef.current.filter((tab) => tab.kind === 'terminal' && !tab.parentTabId).map((tab) => tab.id);

    requestAnimationFrame(() => {
      for (const tabId of tabIds) {
        if (options.force) {
          fitTerminalIfNeeded(tabId, { force: true });
        } else {
          fitTerminalIfNeeded(tabId);
        }
      }

      window.setTimeout(() => {
        for (const tabId of tabIds) fitTerminalIfNeeded(tabId);
      }, 50);

      window.setTimeout(() => {
        for (const tabId of tabIds) fitTerminalIfNeeded(tabId);
      }, 120);
    });
  }

  function focusTerminal(tabId: string) {
    requestAnimationFrame(() => {
      terminalsRef.current.get(tabId)?.focus();
    });
  }

  function attachTerminalToHost(tabId: string, hostEl: HTMLDivElement) {
    const previousHost = terminalHostsRef.current.get(tabId);
    const terminal = terminalsRef.current.get(tabId);
    const terminalElement = terminal?.element;
    const isSameHost = previousHost === hostEl;

    terminalHostsRef.current.set(tabId, hostEl);

    if (!terminal) return;

    if (isSameHost && terminalElement?.parentElement === hostEl && terminalResizeObserversRef.current.has(tabId)) {
      return;
    }

    if (terminalElement && terminalElement.parentElement !== hostEl) {
      hostEl.replaceChildren(terminalElement);
    }

    terminalResizeObserversRef.current.get(tabId)?.disconnect();
    const resizeObserver = new ResizeObserver(() => {
      fitTerminalIfNeeded(tabId);
    });
    resizeObserver.observe(hostEl);
    terminalResizeObserversRef.current.set(tabId, resizeObserver);

    if (!isSameHost) {
      terminalSizeCacheRef.current.delete(tabId);
      scheduleTerminalSettledFit(tabId);
    } else {
      fitTerminalIfNeeded(tabId);
    }
  }

  function writeTerminalInput(tabId: string, data: string) {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || !tab.terminalId) return;
    if (tab.session.id === localSession.id) {
      void sendLocalTerminalInput(tab.terminalId, data);
    } else {
      void terminalWrite(tab.terminalId, data);
    }
  }

  function createActivity(level: TerminalActivityEntry['level'], text: string): TerminalActivityEntry {
    return {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      level,
      text,
    };
  }

  function disposeTerminalRuntime(tab: WorkspaceTab) {
    if (tab.kind === 'terminal' && tab.terminalId) {
      if (tab.session.id !== localSession.id) {
        void disconnectSession(tab.terminalId).catch(() => {});
      } else {
        void stopLocalTerminal(tab.terminalId).catch(() => {});
      }
    }

    terminalDataDisposablesRef.current.get(tab.id)?.dispose();
    terminalResizeObserversRef.current.get(tab.id)?.disconnect();
    fitAddonsRef.current.get(tab.id)?.dispose();
    terminalsRef.current.get(tab.id)?.dispose();
    terminalDataDisposablesRef.current.delete(tab.id);
    terminalResizeObserversRef.current.delete(tab.id);
    terminalSizeCacheRef.current.delete(tab.id);
    terminalsRef.current.delete(tab.id);
    fitAddonsRef.current.delete(tab.id);
    terminalHostsRef.current.delete(tab.id);
    if (tab.terminalId) {
      startedTerminalsRef.current.delete(tab.terminalId);
      terminalIdToTabIdRef.current.delete(tab.terminalId);
      pendingOutputRef.current.delete(tab.terminalId);
    }
  }

  function createTerminalTab(session: Session, statusMessage: string, parentTabId?: string): WorkspaceTab {
    const tabId = `terminal:${session.id}-${crypto.randomUUID()}`;
    return {
      id: tabId,
      kind: 'terminal',
      session,
      title: session.name,
      terminalId: '',
      status: 'connecting',
      output: [],
      statusMessage,
      closedByUser: false,
      reconnectAttempts: 0,
      activityLog: [createActivity('info', statusMessage)],
      layout: createDefaultTerminalLayout(tabId),
      activePaneId: tabId,
      parentTabId,
    };
  }

  async function loadTerminalDirectory(path?: string | null): Promise<LocalDirectoryListing | null> {
    try {
      const listing = await listLocalDirectory(path);
      resourceFilesRef.current = listing.entries.map(toResourceFile);
      return listing;
    } catch {
      return null;
    }
  }

  async function loadLocalDirectory(path?: string | null): Promise<LocalDirectoryListing | null> {
    setIsLoadingFiles(true);
    setFileListError('');

    try {
      const listing = await listLocalDirectory(path);
      const nextFiles = listing.entries.map(toResourceFile);
      setCurrentPath(listing.path);
      setPathInput(listing.path);
      setParentPath(listing.parent ?? null);
      setResourceFiles(nextFiles);
      currentPathRef.current = listing.path;
      resourceFilesRef.current = nextFiles;
      setSelectedFile(null);
      setFilePreview(null);
      setFilePreviewError('');
      setStatusMessage(`已读取本地目录：${listing.path}`);
      return listing;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileListError(message);
      setStatusMessage(`读取本地目录失败：${message}`);
      return null;
    } finally {
      setIsLoadingFiles(false);
    }
  }

  useEffect(() => {
    loadLocalDirectory(null);
    loadTerminalDirectory(fallbackLocalTerminalProfile.cwd);
    listSessions()
      .then(setSessions)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage(`加载连接列表失败：${message}`);
        setSessions([]);
      });
  }, []);

  useEffect(() => {
    let isMounted = true;

    getLocalTerminalProfile().then((profile) => {
      if (!isMounted) return;
      setLocalTerminalProfile(profile);
      void loadTerminalDirectory(profile.cwd);
    }).catch(() => {
      if (!isMounted) return;
      void loadTerminalDirectory(fallbackLocalTerminalProfile.cwd);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeSession = activeTab?.session ?? localSession;
  const visibleTerminalPaneIds = activeTab?.kind === 'terminal'
    ? collectTerminalLayoutTabIds(activeTab.layout ?? createDefaultTerminalLayout(activeTab.id))
    : [];
  const activePaneId = activeTab?.kind === 'terminal'
    ? activeTab.activePaneId ?? activeTab.id
    : null;

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    activePaneIdRef.current = activePaneId;
  }, [activePaneId]);

  useEffect(() => {
    terminalDragStateRef.current = terminalDragState;
  }, [terminalDragState]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    resourceFilesRef.current = resourceFiles;
  }, [resourceFiles]);

  useEffect(() => {
    if (!openingConnection) return;

    const intervalId = window.setInterval(() => {
      setOpeningConnection((current) => {
        if (!current) return null;
        const seconds = Math.floor((Date.now() - current.startedAt) / 1000);
        if (seconds >= 20) {
          const message = '连接超时：SSH 已启动但没有进入可用终端状态';
          setTabs((tabsCurrent) =>
            tabsCurrent.map((tab) =>
              tab.session.id === current.session.id && tab.status === 'connecting'
                ? {
                    ...tab,
                    status: 'failed',
                    statusMessage: message,
                    output: [...tab.output, `\r\n${message}\r\n`],
                    activityLog: [...tab.activityLog, createActivity('error', message)].slice(-20),
                  }
                : tab,
            ),
          );
          setStatusMessage(message);
          return null;
        }
        return { ...current, seconds };
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [openingConnection?.session.id, openingConnection?.startedAt]);

  // Keep the active terminal focused without forcing a layout recalculation on every tab switch.
  useEffect(() => {
    if (activeTab?.kind !== 'terminal' || !activePaneId) return;
    focusTerminal(activePaneId);
    scheduleVisibleTerminalFits({ force: true });
  }, [activeTab?.id, activePaneId]);

  useEffect(() => {
    if (activeTab?.kind !== 'terminal') return;
    scheduleVisibleTerminalFits({ force: true });
  }, [resourceCollapsed, resourcePanelWidth, visibleTerminalPaneIds.join('|')]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (activeTabRef.current?.kind !== 'terminal') return;
      scheduleVisibleTerminalFits({ force: true });
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const filteredSessions = useMemo(() => {
    const q = connectionSearchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) =>
      session.name.toLowerCase().includes(q)
      || session.host.toLowerCase().includes(q)
      || session.username.toLowerCase().includes(q),
    );
  }, [sessions, connectionSearchQuery]);

  const pathBreadcrumbs = useMemo(() => buildPathBreadcrumbs(currentPath), [currentPath]);

  const visibleFiles = useMemo(() => {
    const normalized = fileSearchQuery.trim().toLowerCase();
    const files = normalized
      ? resourceFiles.filter((file) => file.name.toLowerCase().includes(normalized))
      : resourceFiles;
    const sorted = [...files].sort((a, b) => compareResource(a, b, sortKey));
    return sortDirection === 'asc' ? sorted : sorted.reverse();
  }, [fileSearchQuery, resourceFiles, sortDirection, sortKey]);

  async function closeTab(tab: WorkspaceTab) {
    const relatedTabIds = [tab.id, ...tabs.filter((item) => item.parentTabId === tab.id).map((item) => item.id)];
    for (const relatedTab of tabs.filter((item) => relatedTabIds.includes(item.id))) {
      disposeTerminalRuntime({ ...relatedTab, closedByUser: true, status: 'closed' });
    }

    setTabs((current) => current.filter((item) => !relatedTabIds.includes(item.id)));
    setActiveTabId((current) => {
      if (current !== tab.id && !relatedTabIds.includes(current || '')) return current;
      const remaining = tabs.filter((item) => !relatedTabIds.includes(item.id) && !item.parentTabId);
      return remaining[remaining.length - 1]?.id ?? null;
    });
  }

  function focusTerminalPane(tabId: string) {
    const ownerTab = findTerminalWorkspaceOwner(tabsRef.current, tabId);
    if (!ownerTab) return;
    setActiveTabId(ownerTab.id);
    setTabs((current) => current.map((item) => {
      if (item.id !== ownerTab.id) return item;
      const layout = activateTerminalPaneTab(item.layout ?? createDefaultTerminalLayout(item.id), tabId);
      return { ...item, layout, activePaneId: tabId };
    }));
    scheduleTerminalSettledFit(tabId);
    focusTerminal(tabId);
  }

  async function refreshSessionsForConnectionPanel() {
    try {
      setSessions(await listSessions());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`刷新连接列表失败：${message}`);
    }
  }

  function openConnectionManagerForPane(paneTabId: string) {
    setPendingPaneTabId(paneTabId);
    setConnectionPanelMode('manage');
    setStatusMessage('请选择要添加到当前 pane 的连接');
    void refreshSessionsForConnectionPanel();
  }

  async function addTerminalTabToCurrentPane(session: Session) {
    const targetPaneId = pendingPaneTabId ?? activePaneIdRef.current;
    const ownerTab = targetPaneId ? findTerminalWorkspaceOwner(tabsRef.current, targetPaneId) : null;
    if (!targetPaneId || !ownerTab) {
      setConnectionPanelMode(null);
      setPendingPaneTabId(null);
      if (session.id === localSession.id) {
        const nextTab = createTerminalTab(localSession, '正在启动本地终端...');
        setTabs((current) => [...current, nextTab]);
        setActiveTabId(nextTab.id);
        setStatusMessage('已新建本地终端');
      } else {
        await openRemoteTerminal(session);
      }
      return;
    }

    const nextTab = createTerminalTab(
      session,
      session.id === localSession.id ? '正在启动本地终端...' : '正在建立 SSH 连接...',
      ownerTab.id,
    );
    const nextLayout = addTerminalTabToPane(ownerTab.layout ?? createDefaultTerminalLayout(ownerTab.id), targetPaneId, nextTab.id);

    setConnectionPanelMode(null);
    setPendingPaneTabId(null);
    setTabs((current) => [
      ...current.map((item) => item.id === ownerTab.id ? { ...item, layout: nextLayout, activePaneId: nextTab.id } : item),
      nextTab,
    ]);
    setActiveTabId(ownerTab.id);
    setStatusMessage(`已添加到当前 pane：${session.name}`);

    if (session.id !== localSession.id) {
      try {
        setOpeningConnection({ session, startedAt: Date.now(), seconds: 0 });
        const event = await connectSession(session.id);
        const terminalId = event.session_id;
        setTabs((current) =>
          current.map((item) =>
            item.id === nextTab.id
              ? {
                  ...item,
                  terminalId,
                  statusMessage: '等待远程 shell 输出...',
                  activityLog: [...item.activityLog, createActivity('info', 'SSH 已建立，等待远程 shell 输出')].slice(-20),
                }
              : item,
          ),
        );
        setOpeningConnection(null);
        scheduleTerminalSettledFit(nextTab.id);
        setStatusMessage(`SSH 已建立，等待远程终端输出：${session.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setOpeningConnection(null);
        setTabs((current) =>
          current.map((item) =>
            item.id === nextTab.id
              ? {
                  ...item,
                  status: 'failed',
                  statusMessage: message,
                  output: [...item.output, `\r\n${message}\r\n`],
                  activityLog: [...item.activityLog, createActivity('error', message)].slice(-20),
                }
              : item,
          ),
        );
        setStatusMessage(`连接失败：${message}`);
      }
    }

    requestAnimationFrame(() => {
      scheduleTerminalSettledFit(nextTab.id);
      focusTerminal(nextTab.id);
    });
  }

  function closeTerminalPaneTab(paneId: string) {
    const ownerTab = findTerminalWorkspaceOwner(tabsRef.current, paneId);
    if (!ownerTab) return;

    const layout = ownerTab.layout ?? createDefaultTerminalLayout(ownerTab.id);
    const paneIds = collectTerminalLayoutTabIds(layout);
    if (paneIds.length <= 1) {
      void closeTab(ownerTab);
      return;
    }

    const { layout: nextLayout, nextActivePaneId } = removeTerminalTabFromPane(layout, paneId);
    if (!nextLayout || !nextActivePaneId) {
      void closeTab(ownerTab);
      return;
    }

    const paneTab = tabsRef.current.find((item) => item.id === paneId);
    if (paneTab) disposeTerminalRuntime({ ...paneTab, closedByUser: true, status: 'closed' });

    setTabs((current) => current
      .filter((item) => item.id !== paneId)
      .map((item) => item.id === ownerTab.id ? { ...item, layout: nextLayout, activePaneId: nextActivePaneId } : item));
    setActiveTabId(ownerTab.id);
    setStatusMessage('已关闭当前终端 tab');
    scheduleTerminalSettledFit(nextActivePaneId);
    focusTerminal(nextActivePaneId);
  }

  async function openRemoteTerminal(session: Session) {
    const nextTab = createTerminalTab(session, '正在建立 SSH 连接...');
    const tabId = nextTab.id;

    activeTabRef.current = nextTab;
    activeTabIdRef.current = tabId;
    setOpeningConnection({ session, startedAt: Date.now(), seconds: 0 });
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(tabId);
    setStatusMessage(`正在连接：${session.username}@${session.host}:${session.port}`);
    try {
      const event = await connectSession(session.id);
      // The backend returns a terminal_id in event.session_id
      const terminalId = event.session_id;
      setTabs((current) =>
        current.map((item) =>
          item.id === tabId
            ? {
                ...item,
                terminalId,
                statusMessage: '等待远程 shell 输出...',
                activityLog: [...item.activityLog, createActivity('info', 'SSH 已建立，等待远程 shell 输出')].slice(-20),
              }
            : item,
        ),
      );
      setOpeningConnection(null);
      scheduleTerminalSettledFit(tabId);
      setStatusMessage(`SSH 已建立，等待远程终端输出：${session.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpeningConnection(null);
      setTabs((current) =>
        current.map((item) =>
          item.id === tabId
            ? {
                ...item,
                status: 'failed',
                statusMessage: message,
                output: [...item.output, `\r\n${message}\r\n`],
                activityLog: [...item.activityLog, createActivity('error', message)].slice(-20),
              }
            : item,
        ),
      );
      setStatusMessage(`连接失败：${message}`);
    }
  }

  function getConnectionPanelTargetPaneId() {
    if (pendingPaneTabId) return pendingPaneTabId;
    if (activeTabRef.current?.kind === 'terminal') {
      return activePaneIdRef.current ?? activeTabRef.current.id;
    }
    return null;
  }

  async function openConnectionPanelSession(session: Session) {
    const targetPaneId = getConnectionPanelTargetPaneId();
    if (targetPaneId) {
      await addTerminalTabToCurrentPane(session);
      return;
    }

    setConnectionPanelMode(null);
    await openRemoteTerminal(session);
  }

  async function openLocalTerminalFromPanel() {
    const targetPaneId = getConnectionPanelTargetPaneId();
    if (targetPaneId) {
      await addTerminalTabToCurrentPane(localSession);
      return;
    }

    setConnectionPanelMode(null);
    const nextTab = createTerminalTab(localSession, '正在启动本地终端...');
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    setStatusMessage('已新建本地终端');
  }

  async function deleteConnectionSession(session: Session) {
    try {
      // Disconnect all tabs for this session
      const sessionTabs = tabs.filter((item) => item.session.id === session.id);
      const nextSessions = await deleteSession(session.id);
      setSessions(nextSessions);
      // Remove any open tabs and dispose terminals for this session
      for (const tab of sessionTabs) {
        disposeTerminalRuntime({ ...tab, closedByUser: true, status: 'closed' });
      }
      setTabs((current) => current.filter((item) => item.session.id !== session.id));
      setStatusMessage(`已删除连接：${session.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionFormError(message);
      setStatusMessage(`删除连接失败：${message}`);
    }
  }

  function updateConnectionForm(field: keyof ConnectionFormState, value: string) {
    setConnectionForm((current) => ({ ...current, [field]: value }));
    if (connectionFormError) setConnectionFormError('');
  }

  function buildConnectionAuth() {
    if (connectionAuthMethod === 'password') {
      return { type: 'password' as const, secret_id: connectionForm.password.trim() };
    }

    if (connectionAuthMethod === 'public_key') {
      return {
        type: 'private_key' as const,
        key_id: connectionForm.privateKeyPath.trim(),
        passphrase_secret_id: connectionForm.privateKeyPassphrase.trim() || null,
      };
    }

    if (connectionAuthMethod === 'keyboard_interactive') {
      return { type: 'keyboard_interactive' as const, response_secret_id: connectionForm.keyboardInteractiveResponse.trim() };
    }

    return { type: 'gssapi' as const, principal: connectionForm.gssapiPrincipal.trim() || null };
  }

  function validateConnectionForm() {
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

    return '';
  }

  async function saveAndConnectConnection() {
    const error = validateConnectionForm();
    if (error) {
      setConnectionFormError(error);
      setStatusMessage(`保存连接失败：${error}`);
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
    setStatusMessage(`正在保存连接：${session.name}`);

    try {
      const nextSessions = await saveSession(session);
      setSessions(nextSessions);
      setConnectionForm(initialConnectionForm);
      setConnectionAuthMethod('password');
      setConnectionPanelMode(null);
      if (pendingPaneTabId) {
        await addTerminalTabToCurrentPane(session);
      } else {
        await openRemoteTerminal(session);
      }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setConnectionFormError(message);
      setStatusMessage(`保存连接失败：${message}`);
    } finally {
      setIsSavingConnection(false);
    }
  }

  function openNewConnectionTab() {
    setPendingPaneTabId(null);
    setConnectionPanelMode('manage');
    void refreshSessionsForConnectionPanel();
  }

  // Global terminal-output listener — registered once, routes by terminal_id
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let isActive = true;

    void listen<TerminalOutputEvent>('terminal-output', (event) => {
      if (!isActive) return;
      const terminalId = event.payload.terminal_id;
      const rawPayload = event.payload.payload;
      const displayPayload = stripRemoteReadyMarker(rawPayload);

      // Find the tab that owns this terminal_id.
      // Try tabsRef first (fast path), then fall back to terminalIdToTabIdRef
      // which covers the race where PTY output arrives before setTabs
      // flushes the real terminalId (local terminal startup).
      let targetTab = tabsRef.current.find((t) => t.terminalId === terminalId);
      if (!targetTab) {
        const fallbackTabId = terminalIdToTabIdRef.current.get(terminalId);
        if (fallbackTabId) targetTab = tabsRef.current.find((t) => t.id === fallbackTabId);
      }

      // If no tab is mapped yet (race: PTY output arrived before startLocalTerminal resolved),
      // buffer the output so it can be flushed once the mapping is registered.
      if (!targetTab && displayPayload) {
        const pending = pendingOutputRef.current.get(terminalId);
        if (pending) {
          pending.push(displayPayload);
        } else {
          pendingOutputRef.current.set(terminalId, [displayPayload]);
        }
        return;
      }

      setTabs((current) => {
        return current.map((item) => {
          const isMatch = item.terminalId === terminalId ||
            (targetTab && item.id === targetTab.id && !item.terminalId);
          if (!isMatch) return item;
          const itemNextStatus = isRemoteSessionFailureOutput(rawPayload)
            ? 'failed'
            : item.status === 'connecting' && isRemoteSessionReadyOutput(rawPayload)
              ? 'connected'
              : item.status;
          const nextStatusMessage = itemNextStatus === 'connected'
            ? '已连接'
            : itemNextStatus === 'failed'
              ? '连接失败'
              : item.statusMessage;
          const nextActivity = itemNextStatus !== item.status
            ? [
                ...item.activityLog,
                createActivity(itemNextStatus === 'failed' ? 'error' : 'info', nextStatusMessage || itemNextStatus),
              ].slice(-20)
            : item.activityLog;
          return {
            ...item,
            terminalId: item.terminalId || terminalId,
            status: itemNextStatus,
            statusMessage: nextStatusMessage,
            activityLog: nextActivity,
            output: displayPayload ? [...item.output, displayPayload].slice(-500) : item.output,
          };
        });
      });

      // Write to the corresponding xterm instance (if it exists)
      if (targetTab && displayPayload) {
        const term = terminalsRef.current.get(targetTab.id);
        term?.write(displayPayload);
      }

      // Handle status transitions
      if (isRemoteSessionReadyOutput(rawPayload) || isRemoteSessionFailureOutput(rawPayload)) {
        setOpeningConnection((current) =>
          current && targetTab ? null : current,
        );
        if (targetTab) {
          setStatusMessage(isRemoteSessionFailureOutput(rawPayload)
            ? `连接失败：${targetTab.session.name}`
            : `已连接：${targetTab.session.name}`);
        }
      }
    }).then((unlisten) => {
      if (!isActive) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    });

    return () => {
      isActive = false;
      unlistenFn?.();
    };
  }, []);

  // Per-pane terminal creation: visible split panes own stable xterm hosts.
  useEffect(() => {
    const terminalTabs = visibleTerminalPaneIds
      .map((tabId) => tabs.find((tab) => tab.id === tabId && tab.kind === 'terminal'))
      .filter((tab): tab is WorkspaceTab => {
        if (!tab) return false;
        return tab.status !== 'failed';
      });

    for (const terminalTab of terminalTabs) {
      const hostEl = terminalHostsRef.current.get(terminalTab.id);
      if (!hostEl) continue;
      if (terminalsRef.current.has(terminalTab.id)) {
        attachTerminalToHost(terminalTab.id, hostEl);
        continue;
      }

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, Monaco, monospace',
        fontSize: 14,
        fontWeight: 500,
        lineHeight: 1,
        scrollback: 5000,
        theme: oneDarkProTerminalTheme,
      });

      terminal.loadAddon(fitAddon);
      terminal.open(hostEl);
      terminalsRef.current.set(terminalTab.id, terminal);
      fitAddonsRef.current.set(terminalTab.id, fitAddon);

      const tabId = terminalTab.id;

      terminal.attachCustomKeyEventHandler((event) => {
        if (!(event.ctrlKey && event.shiftKey)) return true;

        if (event.type === 'keydown' && event.code === 'KeyC') {
          const selection = terminal.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => {});
          }
          return false;
        }

        if (event.type === 'keydown' && event.code === 'KeyV') {
          void navigator.clipboard.readText()
            .then((text) => {
              if (!text) return;
              writeTerminalInput(tabId, text);
            })
            .catch(() => {});
          return false;
        }

        return true;
      });

      const dataDisposable = terminal.onData((data) => {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (!tab || !tab.terminalId) return;
        if (tab.session.id === localSession.id) {
          void sendLocalTerminalInput(tab.terminalId, data);
        } else {
          void terminalWrite(tab.terminalId, data);
        }
      });
      terminalDataDisposablesRef.current.set(tabId, dataDisposable);

      const syncSize = () => fitTerminalIfNeeded(tabId);

      const resizeObserver = new ResizeObserver(() => {
        fitTerminalIfNeeded(tabId);
      });
      resizeObserver.observe(hostEl);
      terminalResizeObserversRef.current.set(tabId, resizeObserver);

      if (terminalTab.session.id === localSession.id && !startedTerminalsRef.current.has(terminalTab.terminalId)) {
        startedTerminalsRef.current.add(terminalTab.terminalId);
        requestAnimationFrame(() => {
          syncSize();
          if (tabId === activePaneIdRef.current) terminal.focus();
          void startLocalTerminal(localTerminalProfile.cwd || null, terminal.cols, terminal.rows).then((profile) => {
            terminalIdToTabIdRef.current.set(profile.terminal_id, terminalTab.id);
            const pending = pendingOutputRef.current.get(profile.terminal_id);
            if (pending) {
              const term = terminalsRef.current.get(terminalTab.id);
              for (const chunk of pending) {
                term?.write(chunk);
              }
              pendingOutputRef.current.delete(profile.terminal_id);
            }
            setTabs((current) =>
              current.map((item) =>
                item.id === terminalTab.id
                  ? {
                      ...item,
                      terminalId: profile.terminal_id,
                      status: 'connected',
                      statusMessage: '已连接',
                      activityLog: [...item.activityLog, createActivity('info', '本地终端已连接')].slice(-20),
                    }
                  : item,
              ),
            );
            startedTerminalsRef.current.add(profile.terminal_id);
            scheduleTerminalSettledFit(terminalTab.id);
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setTabs((current) =>
              current.map((item) =>
                item.id === terminalTab.id
                  ? {
                      ...item,
                      status: 'failed',
                      statusMessage: message,
                      activityLog: [...item.activityLog, createActivity('error', message)].slice(-20),
                    }
                  : item,
              ),
            );
            setStatusMessage(`本地终端启动失败：${message}`);
          });
        });
      } else if (terminalTab.terminalId && !startedTerminalsRef.current.has(terminalTab.terminalId)) {
        startedTerminalsRef.current.add(terminalTab.terminalId);
        requestAnimationFrame(() => {
          syncSize();
          if (tabId === activePaneIdRef.current) terminal.focus();
        });
      } else {
        requestAnimationFrame(() => {
          syncSize();
          if (tabId === activePaneIdRef.current) terminal.focus();
        });
      }
    }
  }, [visibleTerminalPaneIds.join('|'), tabs.map((tab) => `${tab.id}:${tab.status}`).join('|'), activePaneId]);

  function submitPathInput() {
    const normalized = pathInput.trim();
    loadLocalDirectory(normalized || null);
  }

  function navigateToPath(path: string) {
    loadLocalDirectory(path);
  }

  function navigateUp() {
    if (!parentPath) return;
    loadLocalDirectory(parentPath);
  }

  function toggleSort(key: ResourceSortKey) {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDirection('asc');
  }

  async function openSelectedFile(file: ResourceFile) {
    setSelectedFile(file.name);
    if (file.type === 'directory') {
      loadLocalDirectory(file.path);
      return;
    }

    setIsLoadingPreview(true);
    setFilePreviewError('');

    try {
      const preview = await readLocalFilePreview(file.path);
      setFilePreview(preview);
      setStatusMessage(`已预览文件：${preview.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFilePreview(null);
      setFilePreviewError(message);
      setStatusMessage(`预览文件失败：${message}`);
    } finally {
      setIsLoadingPreview(false);
    }
  }

  function toggleResourcePanel() {
    setResourceCollapsed((current) => !current);
  }

  function startResourceResize(event: PointerEvent<HTMLDivElement>) {
    if (resourceCollapsed) return;

    const container = event.currentTarget.parentElement;
    if (!container) return;

    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    setIsResourceResizing(true);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = ((moveEvent.clientX - bounds.left) / bounds.width) * 100;
      setResourcePanelWidth(clampPanelWidth(nextWidth));
    };

    const stopResize = () => {
      setIsResourceResizing(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  function createEmptyDragState(tabId: string, x = 0, y = 0): TerminalDragState {
    return {
      tabId,
      operation: 'none',
      isOverWorkspace: false,
      targetPaneId: null,
      targetTabId: null,
      side: null,
      reorderPlacement: null,
      ghostX: x,
      ghostY: y,
    };
  }

  // Keep terminalDragStateRef in sync synchronously with the state so that the
  // pointerup drop handlers (which read the ref) see the latest preview even
  // when pointermove and pointerup land in the same task (React only flushes
  // the useEffect-based sync after paint, which is too late for fast drags).
  function applyTerminalDragState(next: TerminalDragState | null) {
    terminalDragStateRef.current = next;
    setTerminalDragState(next);
  }

  function getTabReorderHit(clientX: number, clientY: number) {
    const tabBar = workspaceTabsRef.current;
    if (!tabBar) return null;

    const tabBarRect = tabBar.getBoundingClientRect();
    if (clientX < tabBarRect.left || clientX > tabBarRect.right || clientY < tabBarRect.top || clientY > tabBarRect.bottom) {
      return null;
    }

    for (const [tabId, tabEl] of workspaceTabRefs.current) {
      const rect = tabEl.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      return {
        targetTabId: tabId,
        reorderPlacement: clientX < rect.left + rect.width / 2 ? 'before' as const : 'after' as const,
      };
    }

    const rootTabs = tabsRef.current.filter((tab) => !tab.parentTabId);
    const lastTab = rootTabs[rootTabs.length - 1];
    if (!lastTab) return null;
    return { targetTabId: lastTab.id, reorderPlacement: 'after' as const };
  }

  function getDropSideFromRect(rect: DOMRect, clientX: number, clientY: number): TerminalDropSide | null {
    const edgeX = rect.width * TERMINAL_PANE_EDGE_DROP_RATIO;
    const edgeY = rect.height * TERMINAL_PANE_EDGE_DROP_RATIO;
    const fromLeft = clientX - rect.left;
    const fromRight = rect.right - clientX;
    const fromTop = clientY - rect.top;
    const fromBottom = rect.bottom - clientY;

    const candidates: { side: TerminalDropSide; value: number; threshold: number }[] = [
      { side: 'left', value: fromLeft, threshold: edgeX },
      { side: 'right', value: fromRight, threshold: edgeX },
      { side: 'top', value: fromTop, threshold: edgeY },
      { side: 'bottom', value: fromBottom, threshold: edgeY },
    ];
    const inEdge = candidates.filter((c) => c.value <= c.threshold);
    if (inEdge.length === 0) return null;
    inEdge.sort((a, b) => a.value - b.value);
    return inEdge[0].side;
  }

  function updatePointerDragPreview(tabId: string, clientX: number, clientY: number) {
    const reorderHit = getTabReorderHit(clientX, clientY);
    if (reorderHit) {
      applyTerminalDragState({
        tabId,
        operation: 'reorder',
        isOverWorkspace: false,
        targetPaneId: null,
        targetTabId: reorderHit.targetTabId,
        side: null,
        reorderPlacement: reorderHit.reorderPlacement,
        ghostX: clientX,
        ghostY: clientY,
      });
      return;
    }

    const workspace = terminalWorkspaceRef.current;
    if (!workspace) {
      applyTerminalDragState(createEmptyDragState(tabId, clientX, clientY));
      return;
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const isOverWorkspace = clientX >= workspaceRect.left
      && clientX <= workspaceRect.right
      && clientY >= workspaceRect.top
      && clientY <= workspaceRect.bottom;

    if (!isOverWorkspace) {
      applyTerminalDragState(createEmptyDragState(tabId, clientX, clientY));
      return;
    }

    for (const [paneId, paneEl] of terminalPaneRefs.current) {
      if (paneId === tabId) continue; // never drop onto the dragged tab's own entry
      const rect = paneEl.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const side = getDropSideFromRect(rect, clientX, clientY);
      applyTerminalDragState({
        tabId,
        operation: side ? 'split' : 'replace',
        isOverWorkspace: true,
        targetPaneId: paneId,
        targetTabId: null,
        side,
        reorderPlacement: null,
        ghostX: clientX,
        ghostY: clientY,
      });
      return;
    }

    applyTerminalDragState({
      tabId,
      operation: 'workspace',
      isOverWorkspace: true,
      targetPaneId: null,
      targetTabId: null,
      side: null,
      reorderPlacement: null,
      ghostX: clientX,
      ghostY: clientY,
    });
  }

  function reorderRootTab(sourceTabId: string, targetTabId: string, placement: TerminalReorderPlacement) {
    if (sourceTabId === targetTabId) return;

    const sourceTab = tabsRef.current.find((tab) => tab.id === sourceTabId && !tab.parentTabId);
    const targetTab = tabsRef.current.find((tab) => tab.id === targetTabId && !tab.parentTabId);
    if (!sourceTab || !targetTab) return;

    setTabs((current) => {
      const rootTabs = current.filter((tab) => !tab.parentTabId);
      const childTabs = current.filter((tab) => tab.parentTabId);
      const movingTab = rootTabs.find((tab) => tab.id === sourceTabId);
      if (!movingTab) return current;

      const withoutMoving = rootTabs.filter((tab) => tab.id !== sourceTabId);
      const targetIndex = withoutMoving.findIndex((tab) => tab.id === targetTabId);
      if (targetIndex < 0) return current;
      const insertIndex = placement === 'before' ? targetIndex : targetIndex + 1;
      const nextRootTabs = [...withoutMoving];
      nextRootTabs.splice(insertIndex, 0, movingTab);
      return [...nextRootTabs, ...childTabs];
    });
    setActiveTabId(sourceTabId);
    setStatusMessage(`已调整标签顺序：${sourceTab.title || sourceTab.session.name}`);
  }

  function replacePaneWithTab(draggingTabId: string, targetPaneId: string) {
    if (draggingTabId === targetPaneId) return;

    const sourceTab = tabsRef.current.find((tab) => tab.id === draggingTabId && tab.kind === 'terminal');
    const targetOwner = findTerminalWorkspaceOwner(tabsRef.current, targetPaneId);
    const sourceOwner = findTerminalWorkspaceOwner(tabsRef.current, draggingTabId);
    if (!sourceTab || !targetOwner || !sourceOwner) return;

    const sourceLayout = sourceOwner.layout ?? createDefaultTerminalLayout(sourceOwner.id);
    const nextSourceLayout = removeTerminalPane(sourceLayout, draggingTabId);
    const targetBaseLayout = sourceOwner.id === targetOwner.id && nextSourceLayout
      ? nextSourceLayout
      : targetOwner.layout ?? createDefaultTerminalLayout(targetOwner.id);
    const nextTargetLayout = addTerminalTabToPane(targetBaseLayout, targetPaneId, draggingTabId);

    setTabs((current) => {
      const nextTabs = current.filter((item) => {
        if (sourceOwner.id !== targetOwner.id && !nextSourceLayout && item.id === sourceOwner.id) return false;
        return true;
      }).map((item) => {
        if (sourceOwner.id !== targetOwner.id && sourceOwner.id !== draggingTabId && item.id === sourceOwner.id && nextSourceLayout) {
          return { ...item, layout: nextSourceLayout, activePaneId: collectTerminalLayoutTabIds(nextSourceLayout)[0] ?? item.id };
        }
        if (item.id === targetOwner.id) {
          return { ...item, layout: nextTargetLayout, activePaneId: draggingTabId };
        }
        if (item.id === draggingTabId) {
          return { ...item, parentTabId: targetOwner.id, layout: createDefaultTerminalLayout(draggingTabId), activePaneId: draggingTabId };
        }
        return item;
      });
      return nextTabs;
    });
    setActiveTabId(targetOwner.id);
    setStatusMessage(`已将 ${sourceTab.title || sourceTab.session.name} 加入当前 pane`);
    scheduleTerminalSettledFit(draggingTabId);
    focusTerminal(draggingTabId);
  }

  function moveTabIntoPane(draggingTabId: string, targetPaneId: string, side: TerminalDropSide) {
    if (draggingTabId === targetPaneId) return;

    const sourceTab = tabsRef.current.find((tab) => tab.id === draggingTabId && tab.kind === 'terminal');
    const targetOwner = findTerminalWorkspaceOwner(tabsRef.current, targetPaneId);
    const sourceOwner = findTerminalWorkspaceOwner(tabsRef.current, draggingTabId);
    if (!sourceTab || !targetOwner || !sourceOwner) return;
    if (draggingTabId === targetOwner.id) return;

    const sourceLayout = sourceOwner.layout ?? createDefaultTerminalLayout(sourceOwner.id);
    const nextSourceLayout = removeTerminalPane(sourceLayout, draggingTabId);
    const targetBaseLayout = sourceOwner.id === targetOwner.id && nextSourceLayout
      ? nextSourceLayout
      : targetOwner.layout ?? createDefaultTerminalLayout(targetOwner.id);
    const nextTargetLayout = insertTerminalPane(targetBaseLayout, targetPaneId, draggingTabId, side);

    setTabs((current) => current
      .map((item) => {
        if (sourceOwner.id !== targetOwner.id && sourceOwner.id !== draggingTabId && item.id === sourceOwner.id && nextSourceLayout) {
          return { ...item, layout: nextSourceLayout, activePaneId: collectTerminalLayoutTabIds(nextSourceLayout)[0] ?? item.id };
        }
        if (item.id === targetOwner.id) {
          return { ...item, layout: nextTargetLayout, activePaneId: draggingTabId };
        }
        if (item.id === draggingTabId) {
          return { ...item, parentTabId: targetOwner.id, layout: createDefaultTerminalLayout(draggingTabId), activePaneId: draggingTabId };
        }
        return item;
      }));
    setActiveTabId(targetOwner.id);
    setStatusMessage(`已将 ${sourceTab.title || sourceTab.session.name} 拖放到终端分屏`);
    scheduleTerminalSettledFit(draggingTabId);
    focusTerminal(draggingTabId);
  }

  function startSplitDividerDrag(splitId: string, direction: TerminalSplitDirection, ratio: number, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const container = event.currentTarget.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const nextState: TerminalSplitResizeCandidate = {
      splitId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRatio: ratio,
      containerWidth: Math.max(rect.width, 1),
      containerHeight: Math.max(rect.height, 1),
    };
    terminalSplitResizeRef.current = nextState;
    document.body.classList.add('terminal-split-resizing', `terminal-split-resizing-${direction}`);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const candidate = terminalSplitResizeRef.current;
      if (!candidate || candidate.splitId !== splitId) return;

      moveEvent.preventDefault();
      const delta = candidate.direction === 'horizontal'
        ? (moveEvent.clientX - candidate.startX) / candidate.containerWidth
        : (moveEvent.clientY - candidate.startY) / candidate.containerHeight;
      const nextRatio = clampSplitRatio(candidate.startRatio + delta);
      const ownerTab = tabsRef.current.find((tab) =>
        tab.kind === 'terminal'
        && !tab.parentTabId
        && collectTerminalLayoutTabIds(tab.layout ?? createDefaultTerminalLayout(tab.id)).includes(splitId),
      );
      if (!ownerTab) return;
      setTabs((current) => current.map((item) => {
        if (item.id !== ownerTab.id) return item;
        const layout = updateTerminalSplitRatio(item.layout ?? createDefaultTerminalLayout(item.id), splitId, nextRatio);
        return { ...item, layout };
      }));
    };

    const stopPointerDrag = () => {
      terminalSplitResizeRef.current = null;
      document.body.classList.remove('terminal-split-resizing', 'terminal-split-resizing-horizontal', 'terminal-split-resizing-vertical');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopPointerDrag);
      window.removeEventListener('pointercancel', stopPointerDrag);
      window.removeEventListener('blur', handleWindowBlur);
    };

    const handleWindowBlur = () => stopPointerDrag();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopPointerDrag);
    window.addEventListener('pointercancel', stopPointerDrag);
    window.addEventListener('blur', handleWindowBlur);
  }

  function startTabPointerDrag(tabId: string, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    event.preventDefault();
    terminalPointerDragRef.current = {
      tabId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      previousActiveTabId: activeTabIdRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const candidate = terminalPointerDragRef.current;
      if (!candidate || candidate.tabId !== tabId) return;

      const deltaX = moveEvent.clientX - candidate.startX;
      const deltaY = moveEvent.clientY - candidate.startY;
      const distance = Math.hypot(deltaX, deltaY);
      if (!candidate.active && distance < TERMINAL_TAB_DRAG_THRESHOLD) return;

      if (!candidate.active) {
        terminalPointerDragRef.current = { ...candidate, active: true };
        if (candidate.previousActiveTabId && candidate.previousActiveTabId !== tabId) {
          setActiveTabId(candidate.previousActiveTabId);
        }
        document.body.classList.add('terminal-tab-dragging');
      }

      moveEvent.preventDefault();
      updatePointerDragPreview(tabId, moveEvent.clientX, moveEvent.clientY);
    };

    const stopPointerDrag = (upEvent?: globalThis.PointerEvent) => {
      const candidate = terminalPointerDragRef.current;
      const current = terminalDragStateRef.current;
      if (candidate?.active && current?.tabId === tabId) {
        upEvent?.preventDefault();
        if (current.operation === 'reorder' && current.targetTabId && current.reorderPlacement) {
          reorderRootTab(tabId, current.targetTabId, current.reorderPlacement);
        } else if (current.operation === 'split' && current.targetPaneId && current.side) {
          moveTabIntoPane(tabId, current.targetPaneId, current.side);
        } else if (current.operation === 'replace' && current.targetPaneId) {
          replacePaneWithTab(tabId, current.targetPaneId);
        } else if (current.operation === 'workspace') {
          setStatusMessage('新窗口拖放语义已识别，多窗口承载稍后接入');
        }
      } else if (candidate && !candidate.active) {
        setActiveTabId(tabId);
      }
      terminalPointerDragRef.current = null;
      document.body.classList.remove('terminal-tab-dragging');
      applyTerminalDragState(null);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopPointerDrag);
      window.removeEventListener('pointercancel', stopPointerDrag);
      window.removeEventListener('blur', handleWindowBlur);
    };

    const handleWindowBlur = () => stopPointerDrag();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopPointerDrag);
    window.addEventListener('pointercancel', stopPointerDrag);
    window.addEventListener('blur', handleWindowBlur);
  }

  function getPaneDropClass(paneId: string) {
    if (terminalDragState?.targetPaneId !== paneId) return '';
    if (terminalDragState.operation === 'replace') return ' drop-replace';
    if (terminalDragState.operation !== 'split' || !terminalDragState.side) return '';
    return ` drop-${terminalDragState.side}`;
  }

  function getPaneDropPreview(paneId: string) {
    if (terminalDragState?.targetPaneId !== paneId) return null;
    if (terminalDragState.operation === 'replace') {
      return <div className="terminal-drop-preview replace" />;
    }
    if (terminalDragState.operation !== 'split' || !terminalDragState.side) return null;
    return <div className={`terminal-drop-preview ${terminalDragState.side}`} />;
  }

  function clearTerminalDragPreview() {
    const current = terminalDragStateRef.current;
    if (!current) return;
    const next: TerminalDragState = { ...current, isOverWorkspace: false, targetPaneId: null, side: null };
    terminalDragStateRef.current = next;
    setTerminalDragState(next);
  }

  function getWorkspaceDropPreview() {
    if (!terminalDragState?.isOverWorkspace || terminalDragState.targetPaneId || terminalDragState.operation !== 'workspace') return null;
    return (
      <div className="terminal-workspace-drop-preview">
        <div className="terminal-workspace-drop-preview-mask" />
        <div className="terminal-workspace-drop-preview-center">
          <div className="terminal-workspace-drop-preview-title">可创建新窗口承载该终端</div>
          <div className="terminal-workspace-drop-preview-text">当前版本先识别该语义，后续接入 Tauri 多窗口后启用真实新窗口</div>
        </div>
      </div>
    );
  }

  function getWorkspaceTabDropClass(tabId: string) {
    if (terminalDragState?.operation !== 'reorder' || terminalDragState.targetTabId !== tabId || !terminalDragState.reorderPlacement) {
      return '';
    }
    return ` reorder-${terminalDragState.reorderPlacement}`;
  }

  function getGhostTab() {
    const draggingTabId = terminalDragState?.tabId;
    if (!draggingTabId || terminalDragState.operation === 'none') return null;
    const tab = tabs.find((item) => item.id === draggingTabId);
    if (!tab) return null;
    return (
      <div
        className="workspace-tab-ghost"
        style={{ left: terminalDragState.ghostX + 12, top: terminalDragState.ghostY + 12 }}
      >
        {tab.kind === 'terminal' ? <TerminalSquare size={15} /> : <FolderOpen size={15} />}
        <span>{tab.title || tab.session.name}</span>
      </div>
    );
  }

  function startPaneTabPointerDrag(tabId: string, paneId: string, ownerTabId: string, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    let activated = false;

    const paneEl = terminalPaneRefs.current.get(paneId);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const distance = Math.hypot(dx, dy);
      if (!activated && distance < TERMINAL_TAB_DRAG_THRESHOLD) return;
      activated = true;

      if (paneEl) {
        const paneRect = paneEl.getBoundingClientRect();
        const outside = moveEvent.clientX < paneRect.left || moveEvent.clientX > paneRect.right
          || moveEvent.clientY < paneRect.top || moveEvent.clientY > paneRect.bottom;
        if (outside) {
          cleanup();
          terminalPointerDragRef.current = {
            tabId,
            startX: moveEvent.clientX,
            startY: moveEvent.clientY,
            active: true,
            previousActiveTabId: activeTabIdRef.current,
          };
          document.body.classList.add('terminal-tab-dragging');
          updatePointerDragPreview(tabId, moveEvent.clientX, moveEvent.clientY);

          const globalMove = (ev: globalThis.PointerEvent) => {
            const c = terminalPointerDragRef.current;
            if (!c || c.tabId !== tabId) return;
            ev.preventDefault();
            updatePointerDragPreview(tabId, ev.clientX, ev.clientY);
          };
          const globalUp = (ev?: globalThis.PointerEvent) => {
            const c = terminalPointerDragRef.current;
            const current = terminalDragStateRef.current;
            if (c?.active && current?.tabId === tabId) {
              ev?.preventDefault();
              if (current.operation === 'reorder' && current.targetTabId && current.reorderPlacement) {
                reorderRootTab(tabId, current.targetTabId, current.reorderPlacement);
              } else if (current.operation === 'split' && current.targetPaneId && current.side) {
                moveTabIntoPane(tabId, current.targetPaneId, current.side);
              } else if (current.operation === 'replace' && current.targetPaneId) {
                replacePaneWithTab(tabId, current.targetPaneId);
              } else if (current.operation === 'workspace') {
                setStatusMessage('新窗口拖放语义已识别，多窗口承载稍后接入');
              }
            }
            terminalPointerDragRef.current = null;
            document.body.classList.remove('terminal-tab-dragging');
            applyTerminalDragState(null);
            window.removeEventListener('pointermove', globalMove);
            window.removeEventListener('pointerup', globalUp);
            window.removeEventListener('pointercancel', globalUp);
            window.removeEventListener('blur', globalBlur);
          };
          const globalBlur = () => globalUp();
          window.addEventListener('pointermove', globalMove);
          window.addEventListener('pointerup', globalUp);
          window.addEventListener('pointercancel', globalUp);
          window.addEventListener('blur', globalBlur);
          return;
        }
      }

      for (const [refTabId, el] of paneTabElRefs.current) {
        if (refTabId === tabId) continue;
        const rect = el.getBoundingClientRect();
        if (moveEvent.clientX < rect.left || moveEvent.clientX > rect.right || moveEvent.clientY < rect.top || moveEvent.clientY > rect.bottom) continue;
        const placement = moveEvent.clientX < rect.left + rect.width / 2 ? 'before' as const : 'after' as const;
        setTabs((current) => current.map((item) => {
          if (item.id !== ownerTabId) return item;
          const layout = item.layout ?? createDefaultTerminalLayout(item.id);
          return { ...item, layout: reorderPaneTabIds(layout, paneId, tabId, refTabId, placement) };
        }));
        break;
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handleBlur);
    };

    const handlePointerUp = () => {
      cleanup();
      if (!activated) {
        focusTerminalPane(tabId);
      }
    };

    const handleBlur = () => handlePointerUp();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handleBlur);
  }


  function renderTerminalLayoutNode(node: TerminalLayoutNode, ownerTabId: string): ReactNode {
    if (node.type === 'split') {
      return (
        <div className={`terminal-split terminal-split-${node.direction}`}>
          <div className="terminal-split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
            {renderTerminalLayoutNode(node.first, ownerTabId)}
          </div>
          <div
            className="terminal-split-divider"
            onPointerDown={(event) => startSplitDividerDrag(node.id, node.direction, node.ratio, event)}
          />
          <div className="terminal-split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
            {renderTerminalLayoutNode(node.second, ownerTabId)}
          </div>
        </div>
      );
    }

    const paneTabIds = getLeafTabIds(node);
    const paneTabs = paneTabIds
      .map((tabId) => tabs.find((tab) => tab.id === tabId && tab.kind === 'terminal'))
      .filter((tab): tab is WorkspaceTab => Boolean(tab));
    const paneTab = tabs.find((tab) => tab.id === node.tabId && tab.kind === 'terminal') ?? paneTabs[0];
    if (!paneTab) return null;
    const isActivePane = node.tabId === activePaneId;

    return (
      <section
        ref={(el) => {
          if (el) {
            terminalPaneRefs.current.set(node.tabId, el);
            for (const tabId of paneTabIds) terminalPaneRefs.current.set(tabId, el);
          } else {
            for (const tabId of paneTabIds) terminalPaneRefs.current.delete(tabId);
          }
        }}
        className={`${isActivePane ? 'terminal-split-pane active' : 'terminal-split-pane'}${getPaneDropClass(node.tabId)}`}
        onMouseDown={(event) => {
          if ((event.target as HTMLElement | null)?.closest('.terminal-pane-tabbar')) return;
          focusTerminalPane(node.tabId);
        }}
      >
        {getPaneDropPreview(node.tabId)}
        <div className="terminal-pane-tabbar">
          <div className="terminal-pane-tabs">
            {paneTabs.map((tab) => (
              <div
                key={tab.id}
                ref={(el) => {
                  if (el) paneTabElRefs.current.set(tab.id, el);
                  else paneTabElRefs.current.delete(tab.id);
                }}
                role="tab"
                tabIndex={0}
                draggable={false}
                className={tab.id === node.tabId ? 'terminal-pane-tab active' : 'terminal-pane-tab'}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startPaneTabPointerDrag(tab.id, node.tabId, ownerTabId, event);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  focusTerminalPane(tab.id);
                }}
              >
                <TerminalSquare size={13} />
                <span className={`workspace-tab-state ${tab.status}`} />
                <span className="terminal-pane-tab-title">{tab.title || tab.session.name}</span>
                <button
                  className="terminal-pane-tab-close"
                  title="关闭 tab"
                  onClick={(event) => { event.stopPropagation(); closeTerminalPaneTab(tab.id); }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="terminal-pane-tab-add"
              title="在当前 pane 新建 tab"
              onClick={(event) => { event.stopPropagation(); openConnectionManagerForPane(node.tabId); }}
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
        {paneTab.status === 'failed' ? (
          <div className="terminal-connection-state is-error">
            <Server size={24} />
            <h2>连接失败</h2>
            <p>{paneTab.session.username}@{paneTab.session.host}:{paneTab.session.port}</p>
            <span>{paneTab.statusMessage || '终端没有进入可用状态。'}</span>
          </div>
        ) : (
          <>
            {paneTabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === node.tabId ? 'xterm-host active' : 'xterm-host inactive'}
                ref={(el) => {
                  if (el) {
                    attachTerminalToHost(tab.id, el);
                  } else {
                    terminalHostsRef.current.delete(tab.id);
                  }
                }}
              />
            ))}
            {(paneTab.status === 'connecting' || paneTab.status === 'reconnecting') && (
              <div className="terminal-connection-overlay">
                <RefreshCw size={18} className="spin" />
                <span>{paneTab.statusMessage || '等待终端就绪...'}</span>
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <main className="ssh-workbench">
      <header className="top-strip">
        <div className="connection-tools">
          <button className="tool-button" onClick={() => { setPendingPaneTabId(null); setConnectionPanelMode('create'); }}>
            <Plus size={17} />
            <span>新建连接</span>
          </button>
          <button className="tool-button" onClick={() => { setPendingPaneTabId(null); setConnectionPanelMode('manage'); void refreshSessionsForConnectionPanel(); }}>
            <Server size={17} />
            <span>连接管理</span>
          </button>
          <button className="tool-button" onClick={() => setStatusMessage('终端设置入口待接入')}> 
            <Settings size={16} />
            <span>终端设置</span>
          </button>
          <button className="tool-button" onClick={() => setStatusMessage('MCP 设置入口待接入')}> 
            <Settings size={16} />
            <span>MCP 设置</span>
          </button>
          <button className="tool-button" onClick={() => setStatusMessage('安全中心入口待接入')}> 
            <Shield size={16} />
            <span>安全</span>
          </button>
        </div>

        <div className="top-status">
          {activeSession ? `${activeSession.name} · ${activeSession.username}@${activeSession.host}` : '本地系统'}
        </div>
      </header>

      <section className={isResourceResizing ? 'session-content is-resizing' : 'session-content'}>
        {openingConnection && (
          <div className="connection-opening-overlay">
            <RefreshCw size={18} className="spin" />
            <span>
              正在打开 {openingConnection.session.name || '连接'}... {openingConnection.seconds}s
            </span>
          </div>
        )}
        <aside
          className={resourceCollapsed ? 'file-panel collapsed' : 'file-panel'}
          style={{ width: resourceCollapsed ? undefined : `${resourcePanelWidth}%` }}
        >
          <div className="file-toolbar">
            {!resourceCollapsed && (
              <>
                <button className="icon-button" title="后退" disabled>
                  <ArrowLeft size={17} />
                </button>
                <button className="icon-button" title="前进" disabled>
                  <ArrowRight size={17} />
                </button>
                <button className="icon-button" title="上一级" onClick={navigateUp} disabled={!parentPath || isLoadingFiles}>
                  <span className="path-up-glyph">..</span>
                </button>
                <div className="path-control">
                  <input
                    value={pathInput}
                    spellCheck={false}
                    onChange={(event) => setPathInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitPathInput();
                    }}
                    onBlur={() => setPathInput(currentPath)}
                    disabled={isLoadingFiles}
                  />
                  <button type="button" title="目录历史">
                    <ChevronDown size={15} />
                  </button>
                </div>
                <button className="icon-button" title="上传" onClick={() => setStatusMessage('上传入口待接入')}>
                  <Upload size={17} />
                </button>
                <button className="icon-button" title="刷新" onClick={() => loadLocalDirectory(currentPath || null)} disabled={isLoadingFiles}>
                  <RefreshCw size={17} />
                </button>
              </>
            )}
            <button
              className="icon-button"
              title={resourceCollapsed ? '展开资源视图' : '收起资源视图'}
              onClick={toggleResourcePanel}
            >
              {resourceCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          {!resourceCollapsed && (
            <>
              <div className="path-breadcrumbs">
                <div className="path-breadcrumbs-track">
                  {pathBreadcrumbs.map((crumb, index) => (
                    <button
                      key={crumb.path}
                      className={index === pathBreadcrumbs.length - 1 ? 'path-breadcrumb active' : 'path-breadcrumb'}
                      disabled={index === pathBreadcrumbs.length - 1}
                      onClick={() => navigateToPath(crumb.path)}
                    >
                      <span>{crumb.label}</span>
                      {index < pathBreadcrumbs.length - 1 && <ChevronRight size={13} />}
                    </button>
                  ))}
                </div>
                <div className="search-box file-search-box">
                  <Search size={16} />
                  <input
                    value={fileSearchQuery}
                    type="text"
                    placeholder="筛选当前目录"
                    spellCheck={false}
                    onChange={(event) => setFileSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setFileSearchQuery('');
                    }}
                  />
                  {fileSearchQuery && (
                    <button type="button" className="file-search-clear" title="清空筛选" onClick={() => setFileSearchQuery('')}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div className="file-list">
                <div className="file-list-header">
                  <button className={sortKey === 'name' ? 'sortable-header active' : 'sortable-header'} onClick={() => toggleSort('name')}>
                    名称 {sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                  </button>
                  <button className={sortKey === 'size' ? 'sortable-header active' : 'sortable-header'} onClick={() => toggleSort('size')}>
                    大小 {sortKey === 'size' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                  </button>
                  <div>类型</div>
                  <button
                    className={sortKey === 'modifiedTime' ? 'sortable-header active' : 'sortable-header'}
                    onClick={() => toggleSort('modifiedTime')}
                  >
                    修改时间 {sortKey === 'modifiedTime' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                  </button>
                </div>
                <div className="file-list-body">
                  {!isLoadingFiles && !fileListError && visibleFiles.map((file) => (
                    <button
                      key={file.name}
                      className={selectedFile === file.name ? 'file-item selected' : 'file-item'}
                      onClick={() => setSelectedFile(file.name)}
                      onDoubleClick={() => openSelectedFile(file)}
                    >
                      <span className="file-name">
                        {file.type === 'directory' ? <FolderOpen size={18} className="folder-icon" /> : <File size={18} className="file-icon" />}
                        <span className="file-name-text">{file.name}</span>
                      </span>
                      <span>{file.size}</span>
                      <span>{file.type === 'directory' ? '文件夹' : '文件'}</span>
                      <span>{file.modifiedTime}</span>
                    </button>
                  ))}
                  {isLoadingFiles ? (
                    <div className="file-list-empty-state">
                      <div className="file-list-empty-title">正在读取目录...</div>
                      <div className="file-list-empty-text">{currentPath || '本地系统'}</div>
                    </div>
                  ) : fileListError ? (
                    <div className="file-list-empty-state is-error">
                      <div className="file-list-empty-title">读取目录失败</div>
                      <div className="file-list-empty-text">{fileListError}</div>
                    </div>
                  ) : visibleFiles.length === 0 && (
                    <div className="file-list-empty-state">
                      <div className="file-list-empty-title">没有匹配的项目</div>
                      <div className="file-list-empty-text">调整搜索条件后重试。</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="resource-bottom-panel">
                <div className="resource-bottom-tabs">
                  <button
                    className={resourceBottomTab === 'transfer' ? 'resource-bottom-tab active' : 'resource-bottom-tab'}
                    onClick={() => setResourceBottomTab('transfer')}
                  >
                    传输
                  </button>
                  <button
                    className={resourceBottomTab === 'log' ? 'resource-bottom-tab active' : 'resource-bottom-tab'}
                    onClick={() => setResourceBottomTab('log')}
                  >
                    日志
                  </button>
                </div>
                {resourceBottomTab === 'transfer' ? (
                  <div className="resource-bottom-content">
                    <div className="resource-bottom-empty">暂无传输任务</div>
                  </div>
                ) : (
                  <div className="resource-bottom-content resource-log-view">
                    {resourceLogs.map((line) => (
                      <div key={line} className="resource-log-line">{line}</div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>

        <div
          className={resourceCollapsed ? 'resource-resizer disabled' : 'resource-resizer'}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整资源面板宽度"
          onPointerDown={startResourceResize}
        />

        <section className={activeTab?.kind === 'terminal' ? 'terminal-panel terminal-panel-terminal-only' : 'terminal-panel'}>
          {activeTab?.kind !== 'terminal' && (
            <div className="workspace-tabs" ref={workspaceTabsRef}>
              {tabs.filter((tab) => !tab.parentTabId).map((tab) => (
                <div
                  key={tab.id}
                  ref={(el) => {
                    if (el) {
                      workspaceTabRefs.current.set(tab.id, el);
                    } else {
                      workspaceTabRefs.current.delete(tab.id);
                    }
                  }}
                  role="tab"
                  tabIndex={0}
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                  onPointerDown={(event) => {
                    if (tab.kind === 'terminal') startTabPointerDrag(tab.id, event);
                  }}
                  className={`${activeTabId === tab.id ? 'workspace-tab active' : 'workspace-tab'}${getWorkspaceTabDropClass(tab.id)}`}
                >
                  {tab.kind === 'terminal' ? <TerminalSquare size={15} /> : <FolderOpen size={15} />}
                  <span className={`workspace-tab-state ${tab.status}`} />
                  <span>{tab.title || tab.session.name}</span>
                  <button
                    className="workspace-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="workspace-tab-add" title="新建连接" onClick={openNewConnectionTab}>
                <Plus size={16} />
              </button>
            </div>
          )}

          <div className="workspace-body">
            {!activeTab ? (
              <div className="empty-workspace">
                <div className="empty-icon"><TerminalSquare size={32} /></div>
                <h2>没有活动标签页</h2>
                <p>点击下方按钮或标签栏的 + 新建连接。</p>
                <button className="empty-primary-action" onClick={openNewConnectionTab}>
                  <Plus size={17} />
                  <span>新建连接</span>
                </button>
              </div>
            ) : activeTab.kind === 'terminal' ? (
              <div
                ref={terminalWorkspaceRef}
                className="terminal-pane"
                onPointerLeave={clearTerminalDragPreview}
              >
                {getWorkspaceDropPreview()}
                {getGhostTab()}
                {renderTerminalLayoutNode(activeTab.layout ?? createDefaultTerminalLayout(activeTab.id), activeTab.id)}
              </div>
            ) : (
              <div className="resource-focus-card">
                {isLoadingPreview ? (
                  <div className="resource-preview-empty">
                    <Home size={30} />
                    <h2>正在读取文件...</h2>
                    <p>{selectedFile || '本地文件'}</p>
                  </div>
                ) : filePreview ? (
                  <div className="resource-preview-shell">
                    <div className="resource-preview-header">
                      <div>
                        <div className="resource-preview-title">{filePreview.name}</div>
                        <div className="resource-preview-path">{filePreview.path}</div>
                      </div>
                      <div className="resource-preview-meta">
                        {formatFileSize(filePreview.size)}{filePreview.truncated ? ' · 已截断' : ''}
                      </div>
                    </div>
                    <pre className="resource-preview-content terminal-scrollbar">{filePreview.content}</pre>
                  </div>
                ) : filePreviewError ? (
                  <div className="resource-preview-empty is-error">
                    <File size={30} />
                    <h2>文件无法预览</h2>
                    <p>{filePreviewError}</p>
                  </div>
                ) : (
                  <div className="resource-preview-empty">
                    <Home size={30} />
                    <h2>{activeTab.session.name} 资源视图</h2>
                    <p>
                      {activeTab.session.id === localSession.id
                        ? '左侧双击文本文件可在这里预览真实内容。'
                        : '文件浏览已放入左侧资源面板，后续接入 SFTP 后端后替换当前 mock 列表。'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <footer className="status-bar">
            <span>{statusMessage}</span>
            <span>{tabs.length} 个标签页</span>
          </footer>
        </section>
      </section>

      {connectionPanelMode && (
        <div className="connection-panel-backdrop" onMouseDown={() => { setConnectionPanelMode(null); setPendingPaneTabId(null); }}>
          <section className="connection-panel" onMouseDown={(event) => event.stopPropagation()}>
            <header className="connection-panel-header">
              <div>
                <h2>{connectionPanelMode === 'create' ? '新建连接' : '连接管理'}</h2>
              </div>
              <button className="connection-panel-close" title="关闭" onClick={() => { setConnectionPanelMode(null); setPendingPaneTabId(null); }}>
                <X size={18} />
              </button>
            </header>

            {connectionPanelMode === 'manage' ? (
              <div className="connection-panel-body">
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
                <div className="connection-list terminal-scrollbar">
                  <div className="connection-card connection-card-local">
                    <div className="connection-card-main">
                      <div className="connection-card-title">本地直连</div>
                      <div className="connection-card-target">{localTerminalProfile.shell_name} · {localTerminalProfile.cwd}</div>
                    </div>
                    <div className="connection-card-buttons">
                      <button className="connection-card-action" onClick={() => void openLocalTerminalFromPanel()}>
                        打开
                      </button>
                    </div>
                  </div>
                  {filteredSessions.length > 0 ? (
                    filteredSessions.map((session) => {
                      return (
                        <div key={session.id} className="connection-card">
                          <div className="connection-card-main">
                            <div className="connection-card-title">{session.name}</div>
                            <div className="connection-card-target">
                              {session.username}@{session.host}:{session.port}
                            </div>
                          </div>
                          <div className="connection-card-buttons">
                            <button className="connection-card-action" onClick={() => void openConnectionPanelSession(session)}>
                              连接
                            </button>
                            <button
                              className="connection-card-delete"
                              title="删除连接"
                              onClick={() => void deleteConnectionSession(session)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                      );
                    })
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
                      <span>点击下方按钮新建一个连接。</span>
                    </div>
                  )}
                </div>
                <footer className="connection-panel-actions">
                  <button className="connection-primary-action" onClick={() => setConnectionPanelMode('create')}>
                    <Plus size={16} />
                    <span>新建连接</span>
                  </button>
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
                  <button className="connection-primary-action" onClick={() => void saveAndConnectConnection()} disabled={isSavingConnection}>
                    {isSavingConnection ? '保存中...' : '保存并连接'}
                  </button>
                </footer>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

export default App;