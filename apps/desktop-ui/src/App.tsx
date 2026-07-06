import { listen } from '@tauri-apps/api/event';

import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { EditorPanel, detectLanguage, type EditorTab } from './EditorPanel';
import { VscodeFileIcon } from './FileIcon';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileText,
  FolderOpen,
  Home,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  TerminalSquare,
  Trash2,
  Upload,
  FolderUp,
  X,
  Archive,
  FileArchive,
  Clipboard,
  Scissors,
  ClipboardPaste,
  FilePlus,
  FolderPlus,
  ListChecks,
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
} from 'lucide-react';
import {
  connectSession,
  disconnectSession,
  getLocalTerminalProfile,
  getSystemMonitor,
  getProcessList,
  type ProcessInfo,
  listLocalDirectory,
  listRemoteDirectory,
  listSessions,
  readLocalFileFull,
  readRemoteFileFull,
  writeLocalFile,
  writeRemoteFile,
  uploadFile,
  uploadLocalFile,
  uploadDirectory,
  readFileAsDataUrl,
  downloadRemoteFile,
  extractArchive,
  createArchive,
  deletePath,
  createFile,
  createDirectory,
  copyPath,
  movePath,
  getLocalIpv4,
  resizeLocalTerminal,
  resizeTerminal,
  sendLocalTerminalInput,
  startLocalTerminal,
  stopLocalTerminal,
  terminalWrite,
  openConnectionWindow,
} from './api';
import type { LocalDirectoryEntry, LocalDirectoryListing, LocalTerminalProfile, Session, TerminalOutputEvent, SystemMonitorData } from './api';

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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar']);

function getFileExt(name: string): string {
  const lower = name.toLowerCase();
  // Handle compound extensions like .tar.gz
  for (const compound of ['.tar.gz', '.tar.bz2', '.tar.xz']) {
    if (lower.endsWith(compound)) return compound.slice(1);
  }
  const idx = lower.lastIndexOf('.');
  return idx > 0 ? lower.slice(idx + 1) : '';
}

function getMediaKind(name: string): 'image' | 'video' | 'audio' | null {
  const ext = getFileExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

function isArchive(name: string): boolean {
  return ARCHIVE_EXTS.has(getFileExt(name));
}

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

type TransferRecord = {
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
};

type LogEntry = {
  id: string;
  time: string;
  level: 'info' | 'warn' | 'error';
  text: string;
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

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const unitIndex = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(1024)), units.length - 1);
  const value = bytesPerSec / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function truncateStatus(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
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

  // Special "此电脑" root — just one crumb
  if (normalized === '此电脑') return [{ label: '此电脑', path: '此电脑' }];

  const windowsDriveMatch = normalized.match(/^([A-Za-z]:\\)(.*)$/);
  if (windowsDriveMatch) {
    const root = windowsDriveMatch[1];
    const segments = windowsDriveMatch[2].split('\\').filter(Boolean);
    // Start with "此电脑" as the virtual root, then the drive, then sub-folders
    const crumbs = [{ label: '此电脑', path: '此电脑' }, { label: root, path: root }];
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
    || normalized.includes('ssh shell 启动失败')
    || normalized.includes('ssh 通道创建失败');
}

function isRemoteSessionDisconnectedOutput(payload: string) {
  const normalized = payload.toLowerCase();
  return normalized.includes('连接已关闭')
    || normalized.includes('disconnected');
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
  const [resourcePanelWidth, setResourcePanelWidth] = useState(40);
  const [isResourceResizing, setIsResourceResizing] = useState(false);
  // Left-side activity bar state — which panel is open
  const [leftActivity, setLeftActivity] = useState<'files' | 'monitor' | 'processes' | null>('files');

  const [monitorData, setMonitorData] = useState<SystemMonitorData | null>(null);
  const [isLoadingMonitor, setIsLoadingMonitor] = useState(false);
  const [processList, setProcessList] = useState<ProcessInfo[]>([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [processSortKey, setProcessSortKey] = useState<'cpu' | 'memory' | 'name'>('cpu');
  const [processSearch, setProcessSearch] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [resourceFiles, setResourceFiles] = useState<ResourceFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileListError, setFileListError] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [canNavigateBack, setCanNavigateBack] = useState(false);
  const [canNavigateForward, setCanNavigateForward] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number>(-1);
  const [mediaViewer, setMediaViewer] = useState<{ url: string; name: string; kind: 'image' | 'video' | 'audio' } | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [sortKey, setSortKey] = useState<ResourceSortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [resourceBottomTab, setResourceBottomTab] = useState<ResourceBottomTab>('transfer');
  const [resourceBottomPanelHeight, setResourceBottomPanelHeight] = useState(148);
  const resourceBottomPanelRef = useRef<HTMLDivElement | null>(null);
  const resourceBottomDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [transferRecords, setTransferRecords] = useState<TransferRecord[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [clipboard, setClipboard] = useState<{ paths: string[]; operation: 'copy' | 'cut'; terminalId: string | null } | null>(null);
  const [newItemDialog, setNewItemDialog] = useState<{ type: 'file' | 'directory' } | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [renameDialog, setRenameDialog] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  // Close menubar dropdown when clicking outside
  useEffect(() => {
    if (!activeMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menubar-item')) setActiveMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [activeMenu]);
  const [pendingPaneTabId, setPendingPaneTabId] = useState<string | null>(null);
  const pendingPaneTabIdRef = useRef(pendingPaneTabId);
  pendingPaneTabIdRef.current = pendingPaneTabId;
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeEditorTabId, setActiveEditorTabId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: ResourceFile | null } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const pathEditInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRefs = useRef<Map<string, AbortController>>(new Map());
  const localIpCacheRef = useRef<string | null>(null);
  const [openingConnection, setOpeningConnection] = useState<{ session: Session; startedAt: number; seconds: number } | null>(null);
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
  const paneTabDragActivated = useRef(false);
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
  // Per-pane navigation history: each terminal pane keeps its own back/forward
  // stack so switching between local and remote panes restores the right trail.
  const navHistoryRef = useRef<Map<string, { history: string[]; index: number }>>(new Map());

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

  function addLogEntry(level: LogEntry['level'], text: string) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      level,
      text,
    };
    setLogEntries((current) => [...current, entry].slice(-200));
  }

  function addTransferRecord(record: Omit<TransferRecord, 'id' | 'time' | 'progress' | 'transferred' | 'speed' | 'startTime'>): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: TransferRecord = {
      ...record,
      id,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      progress: 0,
      transferred: 0,
      speed: 0,
      startTime: Date.now(),
    };
    setTransferRecords((current) => [full, ...current].slice(0, 100));
    return id;
  }

  function updateTransferRecord(id: string, patch: Partial<TransferRecord> | ((prev: TransferRecord) => Partial<TransferRecord>)) {
    setTransferRecords((current) =>
      current.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r))
    );
  }

  function deleteTransferRecord(id: string) {
    setTransferRecords((current) => current.filter((r) => r.id !== id));
  }

  function cancelUpload(id: string) {
    const abortCtrl = uploadAbortRefs.current.get(id);
    if (abortCtrl) {
      abortCtrl.abort();
      uploadAbortRefs.current.delete(id);
    }
    updateTransferRecord(id, { status: 'cancelled', message: '已取消' });
    addLogEntry('warn', `上传已取消`);
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
    startedTerminalsRef.current.delete(tab.id);
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
      setSelectedFiles(new Set());
      setLastClickedIndex(-1);
      setMediaViewer(null);
      setMediaError('');
      if (!localIpCacheRef.current) {
        try {
          localIpCacheRef.current = await getLocalIpv4();
        } catch {
          localIpCacheRef.current = '127.0.0.1';
        }
      }
      setStatusMessage(localIpCacheRef.current);
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

  function isLocalResourceTab(tab: WorkspaceTab | null): boolean {
    return !tab || tab.session.id === localSession.id;
  }

  function syncNavButtons(history: string[], index: number) {
    setCanNavigateBack(index > 0);
    setCanNavigateForward(index < history.length - 1);
  }

  // Route directory loading to local or remote based on the active pane tab.
  // `recordHistory` controls whether the navigation pushes a new entry onto the
  // back/forward stack (user-driven navigation) or just restores the view
  // (back/forward/pane-switch).
  async function loadResourceDirectory(path?: string | null, recordHistory = true): Promise<void> {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    setIsLoadingFiles(true);
    setFileListError('');
    try {
      const listing = local
        ? await listLocalDirectory(path)
        : tab?.terminalId
          ? await listRemoteDirectory(tab.terminalId, path)
          : null;
      if (!listing) {
        throw new Error('远程终端尚未连接，无法浏览文件');
      }
      const nextFiles = listing.entries.map(toResourceFile);
      setCurrentPath(listing.path);
      setPathInput(listing.path);
      setParentPath(listing.parent ?? null);
      setResourceFiles(nextFiles);
      currentPathRef.current = listing.path;
      resourceFilesRef.current = nextFiles;
      setSelectedFiles(new Set());
      setLastClickedIndex(-1);
      setMediaViewer(null);
      setMediaError('');
      if (local) {
        if (!localIpCacheRef.current) {
          try {
            localIpCacheRef.current = await getLocalIpv4();
          } catch {
            localIpCacheRef.current = '127.0.0.1';
          }
        }
        setStatusMessage(localIpCacheRef.current);
      } else {
        setStatusMessage(tab?.session.host ?? '');
      }

      // Update per-pane navigation history.
      const paneKey = tab?.id ?? '__local__';
      const entry = navHistoryRef.current.get(paneKey);
      if (recordHistory) {
        if (entry) {
          const truncated = entry.history.slice(0, entry.index + 1);
          if (truncated[truncated.length - 1] !== listing.path) {
            truncated.push(listing.path);
          }
          const nextIndex = truncated.length - 1;
          navHistoryRef.current.set(paneKey, { history: truncated, index: nextIndex });
          syncNavButtons(truncated, nextIndex);
        } else {
          navHistoryRef.current.set(paneKey, { history: [listing.path], index: 0 });
          syncNavButtons([listing.path], 0);
        }
      } else if (entry) {
        syncNavButtons(entry.history, entry.index);
      } else {
        syncNavButtons([], -1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileListError(message);
      setStatusMessage(`读取目录失败：${message}`);
    } finally {
      setIsLoadingFiles(false);
    }
  }

  function navigateBack() {
    const tab = activePaneTabRef.current;
    const paneKey = tab?.id ?? '__local__';
    const entry = navHistoryRef.current.get(paneKey);
    if (!entry || entry.index <= 0) return;
    const nextIndex = entry.index - 1;
    navHistoryRef.current.set(paneKey, { history: entry.history, index: nextIndex });
    void loadResourceDirectory(entry.history[nextIndex], false);
  }

  function navigateForward() {
    const tab = activePaneTabRef.current;
    const paneKey = tab?.id ?? '__local__';
    const entry = navHistoryRef.current.get(paneKey);
    if (!entry || entry.index >= entry.history.length - 1) return;
    const nextIndex = entry.index + 1;
    navHistoryRef.current.set(paneKey, { history: entry.history, index: nextIndex });
    void loadResourceDirectory(entry.history[nextIndex], false);
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

  // The terminal tab that currently owns the resource panel: the active pane
  // inside the active workspace. Local panes browse the local filesystem;
  // remote panes browse the remote filesystem via SFTP-like exec commands.
  const activePaneTab = useMemo(
    () => (activePaneId ? tabs.find((tab) => tab.id === activePaneId && tab.kind === 'terminal') ?? null : null),
    [activePaneId, tabs],
  );
  const activePaneTabRef = useRef<WorkspaceTab | null>(null);
  useEffect(() => {
    activePaneTabRef.current = activePaneTab;
  }, [activePaneTab]);

  // When the active pane changes (switching tabs, focusing a different split
  // pane, or after a remote connection establishes), reload the resource panel
  // so it reflects the newly focused terminal's filesystem.
  useEffect(() => {
    if (!activePaneTab) return;
    // Only auto-switch for remote panes once they are actually connected; local
    // panes can be browsed immediately.
    const ready = isLocalResourceTab(activePaneTab) || activePaneTab.status === 'connected';
    if (!ready) return;
    const paneKey = activePaneTab.id;
    const entry = navHistoryRef.current.get(paneKey);
    if (entry && entry.history[entry.index]) {
      // Pane already has a navigation trail — restore its current position
      // without pushing a new history entry.
      void loadResourceDirectory(entry.history[entry.index], false);
    } else {
      void loadResourceDirectory(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePaneTab?.id, activePaneTab?.status]);

  useEffect(() => {
    terminalDragStateRef.current = terminalDragState;
  }, [terminalDragState]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    resourceFilesRef.current = resourceFiles;
  }, [resourceFiles]);

  // File drag-drop is now handled entirely via HTML5 native events
  // (onDragOver / onDrop / onDragLeave on the file panel <aside>).
  // Setting dragDropEnabled: false in tauri.conf.json allows HTML5 events
  // to work normally — no more forbidden-cursor icon when dragging files.

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
  }, [leftActivity, resourcePanelWidth, visibleTerminalPaneIds.join('|')]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (activeTabRef.current?.kind !== 'terminal') return;
      scheduleVisibleTerminalFits({ force: true });
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

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

  function openConnectionManagerForPane(paneTabId: string) {
    setPendingPaneTabId(paneTabId);
    setStatusMessage('请选择要添加到当前 pane 的连接');
    void openConnectionWindow('manage');
  }

  async function addTerminalTabToCurrentPane(session: Session) {
    const targetPaneId = pendingPaneTabId ?? activePaneIdRef.current;
    const ownerTab = targetPaneId ? findTerminalWorkspaceOwner(tabsRef.current, targetPaneId) : null;
    if (!targetPaneId || !ownerTab) {
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

    await openRemoteTerminal(session);
  }

  async function openLocalTerminalFromPanel() {
    const targetPaneId = getConnectionPanelTargetPaneId();
    if (targetPaneId) {
      await addTerminalTabToCurrentPane(localSession);
      return;
    }

    const nextTab = createTerminalTab(localSession, '正在启动本地终端...');
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    setStatusMessage('已新建本地终端');
  }

  function openNewConnectionTab() {
    void openConnectionWindow('manage');
  }

  // Global terminal-output listener — registered once, routes by terminal_id
  useEffect(() => {
    // Listen for session connection events from the connection window
    let connUnlisten: (() => void) | null = null;
    void listen<Session>('connection-window-connect-session', (event) => {
      const session = event.payload;
      if (pendingPaneTabIdRef.current) {
        void addTerminalTabToCurrentPane(session);
      } else if (session.id === localSession.id) {
        void openLocalTerminalFromPanel();
      } else {
        void openRemoteTerminal(session);
      }
    }).then(fn => { connUnlisten = fn; });
    return () => { connUnlisten?.(); };
  }, []);

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
            : isRemoteSessionDisconnectedOutput(rawPayload) && item.status === 'connected'
              ? 'disconnected'
              : item.status === 'connecting' && isRemoteSessionReadyOutput(rawPayload)
                ? 'connected'
                : item.status;
          const nextStatusMessage = itemNextStatus === 'connected'
            ? '已连接'
            : itemNextStatus === 'failed'
              ? '连接失败'
              : itemNextStatus === 'disconnected'
                ? '已断开'
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
      if (isRemoteSessionReadyOutput(rawPayload) || isRemoteSessionFailureOutput(rawPayload) || isRemoteSessionDisconnectedOutput(rawPayload)) {
        setOpeningConnection((current) =>
          current && targetTab ? null : current,
        );
        if (targetTab) {
          setStatusMessage(isRemoteSessionFailureOutput(rawPayload)
            ? `连接失败：${targetTab.session.name}`
            : isRemoteSessionDisconnectedOutput(rawPayload)
              ? `已断开：${targetTab.session.name}`
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

      if (terminalTab.session.id === localSession.id && !startedTerminalsRef.current.has(terminalTab.id)) {
        startedTerminalsRef.current.add(terminalTab.id);
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
    void loadResourceDirectory(normalized || null);
  }

  function navigateToPath(path: string) {
    void loadResourceDirectory(path);
  }

  function navigateUp() {
    if (!parentPath) return;
    void loadResourceDirectory(parentPath);
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
    setSelectedFiles(new Set([file.name]));
    if (file.type === 'directory') {
      void loadResourceDirectory(file.path);
      return;
    }

    // Images / videos / audio -> media viewer
    const kind = getMediaKind(file.name);
    if (kind) {
      void openMediaViewer(file, kind);
      return;
    }

    // Everything else -> built-in editor
    void openFileInEditor(file);
  }

  async function openMediaViewer(file: ResourceFile, kind: 'image' | 'video' | 'audio') {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    setMediaViewer(null);
    setMediaError('');
    setIsLoadingMedia(true);
    try {
      const url = await readFileAsDataUrl(file.path, local ? null : tab?.terminalId ?? null);
      setMediaViewer({ url, name: file.name, kind });
      setStatusMessage(`正在查看：${file.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMediaError(message);
      setStatusMessage(`无法查看媒体文件：${message}`);
    } finally {
      setIsLoadingMedia(false);
    }
  }

  async function openFileInEditor(file: ResourceFile) {
    // If already open, just focus it.  Must match both path AND the
    // originating session (terminalId) so that the same filename on
    // different servers is treated as separate editor tabs.
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const terminalId = local ? undefined : tab?.terminalId;
    const existing = editorTabs.find((t) =>
      t.path === file.path && t.terminalId === terminalId && t.isRemote === !local
    );
    if (existing) {
      setActiveEditorTabId(existing.id);
      setShowEditor(true);
      return;
    }

    const tabId = `${file.path}::${terminalId ?? 'local'}::${Date.now()}`;
    const newTab: EditorTab = {
      id: tabId,
      path: file.path,
      name: file.name,
      language: detectLanguage(file.name),
      content: '',
      originalContent: '',
      isRemote: !local,
      terminalId,
      loading: true,
      error: '',
    };
    setEditorTabs((current) => [...current, newTab]);
    setActiveEditorTabId(tabId);
    setShowEditor(true);

    // For remote files, add a transfer record so the user can see loading status
    let transferId: string | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const openStartTime = Date.now();
    if (!local && terminalId) {
      transferId = addTransferRecord({
        fileName: file.name,
        direction: 'open',
        target: '编辑器',
        size: file.sizeBytes,
        status: 'uploading',
        message: '正在读取...',
      });
      progressTimer = setInterval(() => {
        if (!transferId) return;
        updateTransferRecord(transferId, (prev) => {
          const elapsedSec = Math.floor((Date.now() - openStartTime) / 1000);
          return { progress: -1, transferred: 0, speed: 0, message: `正在读取... (${elapsedSec}s)` };
        });
      }, 1000);
    }

    try {
      const full = local
        ? await readLocalFileFull(file.path)
        : terminalId
          ? await readRemoteFileFull(terminalId, file.path)
          : null;
      if (progressTimer) clearInterval(progressTimer);
      if (!full) {
        throw new Error('远程终端尚未连接，无法读取文件');
      }
      if (transferId) {
        const elapsed = (Date.now() - openStartTime) / 1000;
        const avgSpeed = elapsed > 0 ? file.sizeBytes / elapsed : 0;
        updateTransferRecord(transferId, { status: 'success', progress: 100, transferred: file.sizeBytes, speed: avgSpeed, message: '已打开' });
      }
      setEditorTabs((current) => current.map((t) =>
        t.id === tabId
          ? { ...t, content: full.content, originalContent: full.content, loading: false }
          : t,
      ));
      setStatusMessage(`已打开文件：${file.path}`);
    } catch (error) {
      if (progressTimer) clearInterval(progressTimer);
      const message = error instanceof Error ? error.message : String(error);
      if (transferId) {
        updateTransferRecord(transferId, { status: 'failed', message });
      }
      setEditorTabs((current) => current.map((t) =>
        t.id === tabId ? { ...t, loading: false, error: message } : t,
      ));
      setStatusMessage(`打开文件失败：${message}`);
    }
  }

  function closeEditorTab(id: string) {
    setEditorTabs((current) => {
      const next = current.filter((t) => t.id !== id);
      if (activeEditorTabId === id) {
        setActiveEditorTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      if (next.length === 0) {
        setShowEditor(false);
      }
      return next;
    });
  }

  function updateEditorContent(id: string, content: string) {
    setEditorTabs((current) => current.map((t) =>
      t.id === id ? { ...t, content } : t,
    ));
  }

  async function saveEditorFile(id: string) {
    const tab = editorTabs.find((t) => t.id === id);
    if (!tab || tab.content === tab.originalContent) return;
    try {
      if (tab.isRemote && tab.terminalId) {
        await writeRemoteFile(tab.terminalId, tab.path, tab.content);
      } else {
        await writeLocalFile(tab.path, tab.content);
      }
      setEditorTabs((current) => current.map((t) =>
        t.id === id ? { ...t, originalContent: tab.content } : t,
      ));
      setStatusMessage(`已保存：${tab.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`保存失败：${message}`);
    }
  }

  function triggerFileUpload() {
    fileInputRef.current?.click();
  }

  function triggerFolderUpload() {
    folderInputRef.current?.click();
  }

  async function uploadFiles(fileList: File[], localPaths?: string[], relativePaths?: string[]) {
    if (fileList.length === 0) return;
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const destDir = currentPath || (local ? '.' : '~');
    const targetLabel = local ? '本地' : `远程 ${tab?.session.name ?? ''}`;
    const terminalId = local ? null : tab?.terminalId ?? null;
    setIsUploading(true);
    let uploaded = 0;
    let failed = '';

    // When relativePaths are provided (directory upload via webkitGetAsEntry),
    // we need to create the directory structure first, then upload files
    // into the correct subdirectory.
    if (relativePaths && relativePaths.length > 0) {
      addLogEntry('info', `开始上传 ${fileList.length} 个文件（含目录结构）到 ${targetLabel}：${destDir}`);
      // Collect all unique directory paths from relativePaths and create them
      const dirsToCreate = new Set<string>();
      for (const relPath of relativePaths) {
        const parts = relPath.split('/');
        // Add all intermediate directory paths
        for (let j = 1; j < parts.length; j++) {
          const dirPath = parts.slice(0, j).join('/');
          dirsToCreate.add(dirPath);
        }
      }
      // Create directories in order (shorter paths first to ensure parent dirs exist)
      const sortedDirs = Array.from(dirsToCreate).sort((a, b) => a.split('/').length - b.split('/').length);
      for (const dirRelPath of sortedDirs) {
        const fullPath = `${destDir}/${dirRelPath}`;
        try {
          await createDirectory(fullPath, local ? null : terminalId);
        } catch (error) {
          // Directory might already exist, continue
          const msg = error instanceof Error ? error.message : String(error);
          addLogEntry('warn', `创建目录 ${dirRelPath}: ${msg}`);
        }
      }
    } else {
      addLogEntry('info', `开始上传 ${fileList.length} 个文件到 ${targetLabel}：${destDir}`);
    }

    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const localPath = localPaths?.[i];
        const relPath = relativePaths?.[i];
        // Determine the actual target directory for this file
        // relPath format: "hooks/subdir/file.js" or "hooks/file.js" (when basePath includes root dir)
        // We need destDir + the directory portion of relPath
        let fileDestDir = destDir;
        if (relPath) {
          const lastSlash = relPath.lastIndexOf('/');
          if (lastSlash > 0) {
            fileDestDir = `${destDir}/${relPath.substring(0, lastSlash)}`;
          } else if (lastSlash === 0) {
            // relPath starts with "/" — shouldn't happen but handle gracefully
            fileDestDir = destDir;
          }
          // If lastSlash === -1, file is at root of the dropped dir → fileDestDir stays destDir
        }
        const displayFileName = relPath || file.name;
        // 远程上传且有本地路径时，走流式上传，避免前端 base64 编码阻塞 UI。
        const useStreamUpload = !local && terminalId && localPath;
        const recordId = addTransferRecord({
          fileName: displayFileName,
          direction: 'upload',
          target: fileDestDir || destDir,
          size: file.size,
          status: 'uploading',
          message: '上传中...',
        });
        const abortCtrl = new AbortController();
        uploadAbortRefs.current.set(recordId, abortCtrl);
        const startTime = Date.now();
        // Listen for real progress events from the Rust backend.
        let lastEventTime = startTime;
        let lastEventTransferred = 0;
        const progressUnlisten = await listen<{ transfer_id: string; transferred: number; total: number }>('upload-progress', (event) => {
          if (event.payload.transfer_id !== recordId) return;
          const transferred = event.payload.transferred;
          const total = event.payload.total;
          const progress = total > 0 ? Math.min((transferred / total) * 100, 100) : 0;
          const now = Date.now();
          const dt = (now - lastEventTime) / 1000;
          const db = transferred - lastEventTransferred;
          const instSpeed = dt > 0 ? db / dt : 0;
          lastEventTime = now;
          lastEventTransferred = transferred;
          updateTransferRecord(recordId, (prev) => {
            const smoothed = prev.speed > 0 ? prev.speed * 0.5 + instSpeed * 0.5 : instSpeed;
            const sizePatch = prev.size === 0 && total > 0 ? { size: total } : {};
            return { progress, transferred, speed: smoothed, message: '正在传输...', ...sizePatch };
          });
        });
        try {
          if (abortCtrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
          if (useStreamUpload) {
            // 流式上传：Rust 端直接读取本地文件分块上传，前端不接触文件内容。
            await uploadLocalFile(localPath!, fileDestDir || destDir, recordId, terminalId!);
          } else {
            // 降级路径：前端读取文件内容并 base64 编码后上传。
            const buffer = await file.arrayBuffer();
            if (abortCtrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
            await uploadFile(file.name, new Uint8Array(buffer), fileDestDir || destDir, recordId, terminalId);
          }
          progressUnlisten();
          uploadAbortRefs.current.delete(recordId);
          uploaded += 1;
          const elapsed = (Date.now() - startTime) / 1000;
          const avgSpeed = elapsed > 0 ? file.size / elapsed : 0;
          updateTransferRecord(recordId, { status: 'success', progress: 100, transferred: file.size, speed: avgSpeed, message: '已完成' });
          addLogEntry('info', `上传成功：${displayFileName} → ${fileDestDir || destDir} (${formatFileSize(file.size)})`);
        } catch (error) {
          progressUnlisten();
          uploadAbortRefs.current.delete(recordId);
          if (abortCtrl.signal.aborted) {
            updateTransferRecord(recordId, { status: 'cancelled', message: '已取消' });
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          failed += `${displayFileName}: ${message}; `;
          updateTransferRecord(recordId, { status: 'failed', message });
          addLogEntry('error', `上传失败：${displayFileName} - ${message}`);
        }
      }
      if (uploaded > 0) {
        setStatusMessage(`已上传 ${uploaded} 个文件到 ${targetLabel}：${destDir}`);
        await loadResourceDirectory(destDir, false);
      }
      if (failed) {
        setStatusMessage(`部分文件上传失败：${failed}`);
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
    // Reset input so selecting the same file again re-triggers change.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleFolderUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);

    // When using webkitdirectory, the browser provides File objects with
    // webkitRelativePath set (e.g. "myFolder/subDir/file.txt").
    // For remote uploads with Tauri, we can use file.path for the local file path.
    const fileArray = Array.from(files);
    const relativePaths = fileArray.map(f => f.webkitRelativePath);
    const localPaths = fileArray.map(f => f.path || '');

    // For remote: if we have local paths, use the directory-level upload command
    // which is much more efficient (creates dirs + streams files from Rust side)
    if (!local && tab?.terminalId && localPaths[0]) {
      // Derive the root directory from the first file's local path.
      // webkitRelativePath is "RootFolder/subDir/file.txt" so we need to
      // remove the relative sub-path from the local path to get the root dir.
      const relParts = relativePaths[0].split('/');
      // Remove the last part (filename) from relParts to get the relative directory path
      const relDirDepth = relParts.length - 1; // number of directory levels below root
      // Remove relDirDepth parts from the end of the local path, plus the filename
      const localParts = localPaths[0].split(/[/\\]/);
      const rootDir = localParts.slice(0, localParts.length - relDirDepth - 1).join('/');
      if (rootDir) {
        await handleDirectoryUpload(rootDir, tab.terminalId);
        if (folderInputRef.current) folderInputRef.current.value = '';
        return;
      }
    }

    // Fallback: upload files individually with relative paths
    await uploadFiles(fileArray, localPaths.length > 0 && localPaths.every(p => p) ? localPaths : undefined, relativePaths);
    if (folderInputRef.current) folderInputRef.current.value = '';
  }

  function handleDragOver(event: React.DragEvent) {
    if (leftActivity !== 'files' || isUploading) return;
    // Must preventDefault on dragover to allow drop and clear the forbidden cursor.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    // Only clear when leaving the panel entirely (not when moving between children).
    if (event.currentTarget === event.target) {
      setIsDragOver(false);
    }
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsDragOver(false);

    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);

    // Use webkitGetAsEntry to detect directories vs files
    const items = event.dataTransfer?.items;
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      if (entries.length > 0) {
        // Separate directories and files
        const dirEntries = entries.filter(e => e.isDirectory);
        const fileEntries = entries.filter(e => e.isFile);

        // Handle directory uploads - directories need recursive traversal
        // since dataTransfer.files only contains leaf files, not directories.
        for (const dirEntry of dirEntries) {
          // Include the directory name as the root in the relative paths
          const collectedFiles = await collectFilesFromDirectoryEntry(
            dirEntry as FileSystemDirectoryEntry,
            dirEntry.name  // ← pass the directory name as basePath so paths include it
          );
          if (collectedFiles.length > 0) {
            // For remote uploads, if we can determine the local directory path
            // (from the first file's .path), use the efficient upload_directory command
            if (!local && tab?.terminalId) {
              const firstRelPath = collectedFiles.paths[0];
              const firstLocalPath = collectedFiles.localPaths[0];
              if (firstRelPath && firstLocalPath) {
                // Derive the root directory from the file's local path.
                // firstRelPath is "dirName/subDir/file.txt" (relative under the dropped dir).
                // firstLocalPath is "C:\full\path\dirName\subDir\file.txt".
                // Root dir = localPath minus the relative path parts minus filename.
                const relParts = firstRelPath.split('/');
                const relDepth = relParts.length - 1; // directory levels below root
                const localParts = firstLocalPath.split(/[/\\]/);
                const rootDir = localParts.slice(0, localParts.length - relDepth - 1).join('/');
                if (rootDir) {
                  await handleDirectoryUpload(rootDir, tab.terminalId);
                  continue;
                }
              }
            }
            // Fallback: upload files individually with relative paths
            await uploadFiles(
              collectedFiles.files,
              collectedFiles.localPaths.length > 0 && collectedFiles.localPaths.every(p => p) ? collectedFiles.localPaths : undefined,
              collectedFiles.paths
            );
          }
        }

        // Handle individual file uploads
        if (fileEntries.length > 0) {
          // For file entries, we can get the File objects from dataTransfer.files
          // Note: dataTransfer.files indices correspond to file-type items only
          const allFiles = event.dataTransfer?.files;
          if (allFiles && allFiles.length > 0) {
            const fileObjects: File[] = [];
            const localPaths: string[] = [];
            // Map file entries to their corresponding File objects
            let fileIdx = 0;
            for (let i = 0; i < entries.length; i++) {
              if (entries[i].isFile) {
                if (fileIdx < allFiles.length) {
                  fileObjects.push(allFiles[fileIdx]);
                  localPaths.push(allFiles[fileIdx].path || '');
                  fileIdx++;
                }
              }
            }
            await uploadFiles(fileObjects, localPaths.length > 0 && localPaths.every(p => p) ? localPaths : undefined);
          }
        }
        return;
      }
    }

    // Fallback: no webkitGetAsEntry support, treat all as files
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
  }

  /// Recursively collect all files from a FileSystemDirectoryEntry,
  /// preserving relative paths for creating the directory structure.
  /// Also collects local filesystem paths (Tauri's File.path) for stream uploads.
  async function collectFilesFromDirectoryEntry(
    dirEntry: FileSystemDirectoryEntry,
    basePath: string = ''
  ): Promise<{ files: File[]; paths: string[]; localPaths: string[]; length: number }> {
    const files: File[] = [];
    const paths: string[] = [];
    const localPaths: string[] = [];

    const reader = dirEntry.createReader();
    const entries = await readAllDirectoryEntries(reader);

    for (const entry of entries) {
      const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const file = await getFileFromEntry(entry as FileSystemFileEntry);
        if (file) {
          files.push(file);
          paths.push(entryPath);
          localPaths.push(file.path || '');
        }
      } else if (entry.isDirectory) {
        const subResult = await collectFilesFromDirectoryEntry(
          entry as FileSystemDirectoryEntry,
          entryPath
        );
        files.push(...subResult.files);
        paths.push(...subResult.paths);
        localPaths.push(...subResult.localPaths);
      }
    }

    return { files, paths, localPaths, length: files.length };
  }

  /// Read all entries from a directory reader (may need multiple reads).
  async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    const allEntries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      allEntries.push(...batch);
    } while (batch.length > 0);
    return allEntries;
  }

  /// Get a File object from a FileSystemFileEntry.
  async function getFileFromEntry(entry: FileSystemFileEntry): Promise<File | null> {
    return new Promise<File | null>((resolve) => {
      entry.file(resolve, () => resolve(null));
    });
  }

  /// Upload a local directory to remote via the upload_directory command.
  async function handleDirectoryUpload(localPath: string, terminalId: string) {
    const destDir = currentPath || '~';
    const dirName = localPath.split(/[/\\]/).pop() || '';
    setIsUploading(true);
    addLogEntry('info', `开始上传目录 ${dirName} 到远程：${destDir}`);
    setStatusMessage(`正在上传目录 ${dirName}...`);

    try {
      const result = await uploadDirectory(localPath, destDir, terminalId);
      const msg = result.failed_items.length > 0
        ? `目录上传完成：${result.files_uploaded} 个文件，${result.dirs_created} 个目录${result.failed_items.length > 0 ? `，${result.failed_items.length} 个失败` : ''}`
        : `目录上传完成：${result.files_uploaded} 个文件，${result.dirs_created} 个目录`;
      addLogEntry(result.failed_items.length > 0 ? 'warn' : 'info', msg);
      if (result.failed_items.length > 0) {
        addLogEntry('error', `失败项：${result.failed_items.join('; ')}`);
      }
      setStatusMessage(msg);
      await loadResourceDirectory(destDir, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLogEntry('error', `目录上传失败：${message}`);
      setStatusMessage(`目录上传失败：${message}`);
    } finally {
      setIsUploading(false);
    }
  }

  // Prevent the browser from showing the "forbidden" cursor when dragging
  // files over the window. Calling preventDefault() on the top-level element
  // tells the browser "this page handles drops", which removes the
  // prohibitive icon. The actual upload only happens when the drop lands on
  // the file-panel <aside> (handled by handleDrop above).
  function handleGlobalDragOver(event: React.DragEvent) {
    event.preventDefault();
  }

  function handleGlobalDrop(event: React.DragEvent) {
    // Suppress browser default (open file in window) for drops outside the
    // file panel. Drops inside the file panel are already handled by
    // handleDrop which also calls preventDefault().
    if (!(event.target as HTMLElement).closest('.file-panel')) {
      event.preventDefault();
    }
  }

  async function downloadFileToLocal(file: ResourceFile) {
    const tab = activePaneTabRef.current;
    if (!tab?.terminalId) {
      setStatusMessage('仅支持下载远程文件到本地');
      return;
    }
    const localDir = currentPathRef.current || '.';
    addLogEntry('info', `开始下载：${file.name} → ${localDir}`);
    const recordId = addTransferRecord({
      fileName: file.name,
      direction: 'download',
      target: localDir,
      size: file.sizeBytes,
      status: 'uploading',
      message: '下载中...',
    });
    const startTime = Date.now();
    const progressTimer = setInterval(() => {
      updateTransferRecord(recordId, (prev) => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (prev.progress >= 85) {
          const transferredAt85 = Math.floor(0.85 * file.sizeBytes);
          const realSpeed = elapsed > 0 ? transferredAt85 / elapsed : 0;
          return { speed: realSpeed, message: '正在接收数据...' };
        }
        const inc = Math.random() * 2 + 1;
        const newProgress = Math.min(prev.progress + inc, 85);
        const newTransferred = Math.floor((newProgress / 100) * file.sizeBytes);
        const realSpeed = elapsed > 0 ? newTransferred / elapsed : 0;
        return { progress: newProgress, transferred: newTransferred, speed: realSpeed };
      });
    }, 300);
    try {
      const savedPath = await downloadRemoteFile(tab.terminalId, file.path, localDir);
      clearInterval(progressTimer);
      const elapsed = (Date.now() - startTime) / 1000;
      const avgSpeed = elapsed > 0 ? file.sizeBytes / elapsed : 0;
      updateTransferRecord(recordId, { status: 'success', progress: 100, transferred: file.sizeBytes, speed: avgSpeed, message: '已完成' });
      addLogEntry('info', `下载完成：${file.name} → ${savedPath} (${formatFileSize(file.sizeBytes)})`);
      setStatusMessage(`已下载到：${savedPath}`);
    } catch (error) {
      clearInterval(progressTimer);
      const message = error instanceof Error ? error.message : String(error);
      updateTransferRecord(recordId, { status: 'failed', message });
      addLogEntry('error', `下载失败：${file.name} - ${message}`);
      setStatusMessage(`下载失败：${message}`);
    }
  }

  async function handleExtractArchive(file: ResourceFile) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    setStatusMessage(`正在解压：${file.name}...`);
    addLogEntry('info', `开始解压：${file.name}`);
    try {
      await extractArchive(file.path, local ? null : tab?.terminalId ?? null);
      setStatusMessage(`解压完成：${file.name}`);
      addLogEntry('info', `解压完成：${file.name}`);
      await loadResourceDirectory(currentPathRef.current || null, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`解压失败：${message}`);
      addLogEntry('error', `解压失败：${file.name} - ${message}`);
    }
  }

  async function handleCreateArchive(file: ResourceFile) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    setStatusMessage(`正在压缩：${file.name}...`);
    addLogEntry('info', `开始压缩：${file.name}`);
    try {
      const archiveName = await createArchive(file.path, local ? null : tab?.terminalId ?? null);
      setStatusMessage(`压缩完成：${archiveName}`);
      addLogEntry('info', `压缩完成：${archiveName}`);
      await loadResourceDirectory(currentPathRef.current || null, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`压缩失败：${message}`);
      addLogEntry('error', `压缩失败：${file.name} - ${message}`);
    }
  }

  // ── Multi-selection helpers ──────────────────────────────
  function handleFileClick(event: React.MouseEvent, file: ResourceFile, index: number) {
    const ctrl = event.ctrlKey || event.metaKey; // metaKey for macOS
    const shift = event.shiftKey;

    if (ctrl) {
      // Toggle individual item
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(file.name)) next.delete(file.name);
        else next.add(file.name);
        return next;
      });
      setLastClickedIndex(index);
    } else if (shift && lastClickedIndex >= 0) {
      // Range select from last clicked to current
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const names = visibleFiles.slice(start, end + 1).map((f) => f.name);
      setSelectedFiles(new Set(names));
    } else {
      // Single select
      setSelectedFiles(new Set([file.name]));
      setLastClickedIndex(index);
    }
  }

  function getSelectedResourceFiles(): ResourceFile[] {
    return visibleFiles.filter((f) => selectedFiles.has(f.name));
  }

  function handleSelectAll() {
    setSelectedFiles(new Set(visibleFiles.map((f) => f.name)));
  }

  function handleResourceKeyDown(event: React.KeyboardEvent) {
    const ctrl = event.ctrlKey || event.metaKey;
    const selectedItems = getSelectedResourceFiles();

    // Delete key — delete selected files
    if (event.key === 'Delete' && selectedItems.length > 0) {
      void handleDeletePaths(selectedItems);
      return;
    }

    if (!ctrl) return;

    switch (event.key.toLowerCase()) {
      case 'a':
        event.preventDefault();
        handleSelectAll();
        break;
      case 'c':
        if (selectedItems.length > 0) {
          event.preventDefault();
          handleCopyFiles(selectedItems);
        }
        break;
      case 'x':
        if (selectedItems.length > 0) {
          event.preventDefault();
          handleCutFiles(selectedItems);
        }
        break;
      case 'v':
        if (clipboard) {
          event.preventDefault();
          void handlePasteFile();
        }
        break;
    }
  }

  function handleFileContextMenu(event: React.MouseEvent, file: ResourceFile) {
    event.preventDefault();
    event.stopPropagation();
    // If the right-clicked file is not in the current selection,
    // switch to single-select it so context-menu actions are intuitive.
    if (!selectedFiles.has(file.name)) {
      setSelectedFiles(new Set([file.name]));
      setLastClickedIndex(visibleFiles.findIndex((f) => f.name === file.name));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, file });
  }

  function handleBlankContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, file: null });
  }

  async function handleDeletePaths(files: ResourceFile[]) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const count = files.length;
    const label = count === 1 ? files[0].name : `${count} 个项目`;
    if (!confirm(`确定删除「${label}」吗？此操作不可恢复。`)) return;
    setStatusMessage(`正在删除 ${label}...`);
    let successCount = 0;
    for (const file of files) {
      try {
        await deletePath(file.path, local ? null : tab?.terminalId ?? null);
        successCount++;
        addLogEntry('info', `已删除：${file.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addLogEntry('error', `删除失败：${file.name} - ${message}`);
      }
    }
    if (successCount === count) {
      setStatusMessage(`已删除 ${label}`);
    } else {
      setStatusMessage(`已删除 ${successCount}/${count} 个项目`);
    }
    setSelectedFiles(new Set());
    setLastClickedIndex(-1);
    await loadResourceDirectory(currentPathRef.current || null, false);
  }

  function handleCopyFiles(files: ResourceFile[]) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const paths = files.map((f) => f.path);
    setClipboard({ paths, operation: 'copy', terminalId: local ? null : tab?.terminalId ?? null });
    setStatusMessage(`已复制 ${files.length} 个项目`);
  }

  function handleCutFiles(files: ResourceFile[]) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const paths = files.map((f) => f.path);
    setClipboard({ paths, operation: 'cut', terminalId: local ? null : tab?.terminalId ?? null });
    setStatusMessage(`已剪切 ${files.length} 个项目`);
  }

  /** Generate a non-conflicting destination name.
   *  If `baseName` already exists in `existingNames`, try baseName (1), baseName (2), …
   *  For files with extensions, the suffix goes before the extension:
   *    file.txt → file (1).txt, file (2).txt …
   *  For directories or files without extensions, the suffix goes at the end:
   *    folder → folder (1), folder (2) …
   */
  function generateUniqueName(baseName: string, existingNames: Set<string>): string {
    if (!existingNames.has(baseName)) return baseName;
    // Split into stem + extension (only treat the last dot as extension if there is one)
    const lastDot = baseName.lastIndexOf('.');
    let stem: string;
    let ext: string;
    if (lastDot > 0) {
      stem = baseName.substring(0, lastDot);
      ext = baseName.substring(lastDot); // includes the dot
    } else {
      stem = baseName;
      ext = '';
    }
    let counter = 1;
    while (existingNames.has(`${stem} (${counter})${ext}`)) {
      counter++;
    }
    return `${stem} (${counter})${ext}`;
  }

  async function handlePasteFile() {
    if (!clipboard || clipboard.paths.length === 0) return;
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const destDir = currentPathRef.current || (local ? '.' : '~');
    // Build a set of existing file names in the destination directory.
    const existingNames = new Set(resourceFilesRef.current.map((f) => f.name));
    setStatusMessage(`正在粘贴 ${clipboard.paths.length} 个项目...`);
    try {
      for (const srcPath of clipboard.paths) {
        const srcName = srcPath.substring(srcPath.lastIndexOf('/') + 1);
        // When cutting within the same directory (source parent == destDir),
        // this is a no-op — skip it.
        const srcParent = srcPath.substring(0, srcPath.lastIndexOf('/'));
        if (clipboard.operation === 'cut' && srcParent === destDir) {
          addLogEntry('info', `剪切跳过：${srcName} 已在目标目录中`);
          continue;
        }
        const destName = generateUniqueName(srcName, existingNames);
        if (clipboard.operation === 'copy') {
          await copyPath(srcPath, destDir, clipboard.terminalId, destName === srcName ? undefined : destName);
          addLogEntry('info', `已复制：${srcPath} → ${destDir}/${destName}`);
        } else {
          await movePath(srcPath, destDir, clipboard.terminalId, destName === srcName ? undefined : destName);
          addLogEntry('info', `已移动：${srcPath} → ${destDir}/${destName}`);
        }
        // Register the new name so subsequent items in the same batch also avoid it.
        existingNames.add(destName);
      }
      if (clipboard.operation === 'copy') {
        setStatusMessage(`已复制 ${clipboard.paths.length} 个项目到：${destDir}`);
      } else {
        setStatusMessage(`已移动 ${clipboard.paths.length} 个项目到：${destDir}`);
        setClipboard(null);
      }
      await loadResourceDirectory(currentPathRef.current || null, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`粘贴失败：${message}`);
      addLogEntry('error', `粘贴失败：${message}`);
    }
  }

  function openNewItemDialog(type: 'file' | 'directory') {
    setNewItemName('');
    setNewItemDialog({ type });
  }

  async function handleCreateNewItem() {
    if (!newItemDialog || !newItemName.trim()) return;
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const baseDir = currentPathRef.current || (local ? '.' : '~');
    const sep = baseDir.endsWith('/') ? '' : '/';
    const fullPath = `${baseDir}${sep}${newItemName.trim()}`;
    setStatusMessage(`正在创建：${newItemName.trim()}...`);
    try {
      if (newItemDialog.type === 'file') {
        await createFile(fullPath, local ? null : tab?.terminalId ?? null);
      } else {
        await createDirectory(fullPath, local ? null : tab?.terminalId ?? null);
      }
      setStatusMessage(`已创建：${newItemName.trim()}`);
      addLogEntry('info', `已创建${newItemDialog.type === 'file' ? '文件' : '文件夹'}：${newItemName.trim()}`);
      setNewItemDialog(null);
      await loadResourceDirectory(currentPathRef.current || null, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`创建失败：${message}`);
      addLogEntry('error', `创建失败：${message}`);
    }
  }

  function openRenameDialog(file: ResourceFile) {
    setRenameValue(file.name);
    setRenameDialog(file.path);
  }

  async function handleRename() {
    if (!renameDialog || !renameValue.trim()) return;
    const newName = renameValue.trim();
    const currentName = renameDialog.split('/').pop() ?? renameDialog;
    if (newName === currentName) {
      setRenameDialog(null);
      return;
    }
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const parent = renameDialog.substring(0, renameDialog.lastIndexOf('/'));
    setStatusMessage(`正在重命名：${newName}...`);
    try {
      await movePath(renameDialog, parent, local ? null : tab?.terminalId ?? null);
      setStatusMessage(`已重命名为：${newName}`);
      addLogEntry('info', `已重命名：${newName}`);
      setRenameDialog(null);
      await loadResourceDirectory(currentPathRef.current || null, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`重命名失败：${message}`);
      addLogEntry('error', `重命名失败：${message}`);
    }
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [contextMenu]);

  // Auto-refresh system monitor data every 5 seconds when panel is open
  useEffect(() => {
    if (leftActivity !== 'monitor') return;
    const interval = window.setInterval(() => void refreshMonitorData(), 1000);
    return () => window.clearInterval(interval);
  }, [leftActivity]);

  // Auto-refresh process list every 3 seconds when panel is open
  useEffect(() => {
    if (leftActivity !== 'processes') return;
    const interval = window.setInterval(() => void refreshProcessList(), 3000);
    return () => window.clearInterval(interval);
  }, [leftActivity]);

  function toggleLeftActivity(panel: 'files' | 'monitor' | 'processes') {
    // VSCode 风格：再次点击已激活的图标则收起侧边栏
    const nextPanel = leftActivity === panel ? null : panel;
    setLeftActivity(nextPanel);
    if (nextPanel === 'monitor') {
      void refreshMonitorData();
    } else if (nextPanel === 'processes') {
      void refreshProcessList();
    }
  }

  async function refreshMonitorData() {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const terminalId = local ? null : tab?.terminalId ?? null;
    setIsLoadingMonitor(true);
    try {
      const data = await getSystemMonitor(terminalId);
      setMonitorData(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`获取系统监控数据失败：${message}`);
    } finally {
      setIsLoadingMonitor(false);
    }
  }

  async function refreshProcessList() {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const terminalId = local ? null : tab?.terminalId ?? null;
    setIsLoadingProcesses(true);
    try {
      const data = await getProcessList(terminalId);
      setProcessList(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`获取进程列表失败：${message}`);
    } finally {
      setIsLoadingProcesses(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  }

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    return `${minutes}分钟`;
  }

  function startResourceResize(event: PointerEvent<HTMLDivElement>) {
    if (!leftActivity) return;

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
      const rect = paneEl.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const side = getDropSideFromRect(rect, clientX, clientY);
      // Self-pane: only allow split (not replace)
      if (paneId === tabId) {
        if (!side) continue;
        applyTerminalDragState({
          tabId,
          operation: 'split',
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
    const sourceTab = tabsRef.current.find((tab) => tab.id === draggingTabId && tab.kind === 'terminal');
    const targetOwner = findTerminalWorkspaceOwner(tabsRef.current, targetPaneId);
    const sourceOwner = findTerminalWorkspaceOwner(tabsRef.current, draggingTabId);
    if (!sourceTab || !targetOwner || !sourceOwner) return;
    if (draggingTabId === targetOwner.id) return;

    // Self-split: dragging a tab onto its own pane edge
    if (draggingTabId === targetPaneId) {
      // If the pane has multiple tabs, perform a real split (move this tab out)
      const ownerLayout = sourceOwner.layout ?? createDefaultTerminalLayout(sourceOwner.id);
      const selfEl = terminalPaneRefs.current.get(draggingTabId);
      const samePaneTabIds = collectTerminalLayoutTabIds(ownerLayout).filter((id) =>
        terminalPaneRefs.current.get(id) === selfEl
      );

      if (samePaneTabIds.length > 1) {
        // Find a sibling tab in the same pane to use as the split anchor
        const anchorTabId = samePaneTabIds.find((id) => id !== draggingTabId) ?? samePaneTabIds[0];
        const nextLayout = insertTerminalPane(ownerLayout, anchorTabId, draggingTabId, side);
        setTabs((current) => current.map((item) => {
          if (item.id === sourceOwner.id) {
            return { ...item, layout: nextLayout, activePaneId: draggingTabId };
          }
          if (item.id === draggingTabId) {
            return { ...item, parentTabId: sourceOwner.id, layout: createDefaultTerminalLayout(draggingTabId), activePaneId: draggingTabId };
          }
          return item;
        }));
        setStatusMessage(`已将 ${sourceTab.title || sourceTab.session.name} 拆分到新面板`);
        scheduleTerminalSettledFit(draggingTabId);
        focusTerminal(draggingTabId);
      } else {
        // Only one tab in pane: self-split is not meaningful, ignore
      }
      return;
    }

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

    paneTabDragActivated.current = false;
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
      paneTabDragActivated.current = true;

      if (paneEl) {
        const paneRect = paneEl.getBoundingClientRect();
        const outside = moveEvent.clientX < paneRect.left || moveEvent.clientX > paneRect.right
          || moveEvent.clientY < paneRect.top || moveEvent.clientY > paneRect.bottom;

        // Check if pointer is in the edge zone of the current pane (for same-pane split)
        const inSplitEdge = !outside && getDropSideFromRect(paneRect, moveEvent.clientX, moveEvent.clientY) !== null;

        if (outside || inSplitEdge) {
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
        <div className="terminal-pane-tabbar" onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('.terminal-pane-tab, .terminal-pane-tab-add')) return;
          openConnectionManagerForPane(node.tabId);
        }}>
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
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (paneTabDragActivated.current) { paneTabDragActivated.current = false; return; }
                  void addTerminalTabToCurrentPane(tab.session);
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
    <main className="ssh-workbench" onDragOver={handleGlobalDragOver} onDrop={handleGlobalDrop}>
      <header className="top-strip">
        <nav className="menubar" role="menubar">
          <div className="menubar-item" role="menuitem" tabIndex={0}
            onMouseEnter={() => { if (activeMenu) setActiveMenu('连接'); }}
            onClick={() => setActiveMenu(activeMenu === '连接' ? null : '连接')}
          >
            <span className="menubar-label">连接<span className="menubar-accent">(F)</span></span>
            {activeMenu === '连接' && (
              <div className="menubar-dropdown" role="menu">
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); void openConnectionWindow('create'); }}>
                  <Plus size={14} /><span>新建连接</span>
                </button>
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); void openConnectionWindow('manage'); }}>
                  <Server size={14} /><span>连接管理</span>
                </button>
              </div>
            )}
          </div>
          <div className="menubar-item" role="menuitem" tabIndex={0}
            onMouseEnter={() => { if (activeMenu) setActiveMenu('编辑'); }}
            onClick={() => setActiveMenu(activeMenu === '编辑' ? null : '编辑')}
          >
            <span className="menubar-label">编辑<span className="menubar-accent">(E)</span></span>
            {activeMenu === '编辑' && (
              <div className="menubar-dropdown" role="menu">
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); /* TODO: settings */ }}>
                  <Settings size={14} /><span>终端设置</span>
                </button>
              </div>
            )}
          </div>
          <div className="menubar-item" role="menuitem" tabIndex={0}
            onMouseEnter={() => { if (activeMenu) setActiveMenu('查看'); }}
            onClick={() => setActiveMenu(activeMenu === '查看' ? null : '查看')}
          >
            <span className="menubar-label">查看<span className="menubar-accent">(V)</span></span>
            {activeMenu === '查看' && (
              <div className="menubar-dropdown" role="menu">
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); setLeftActivity('files'); }}>
                  <FolderOpen size={14} /><span>文件资源管理器</span>
                </button>
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); setLeftActivity('monitor'); }}>
                  <Cpu size={14} /><span>系统监控</span>
                </button>
                <button className="menubar-menu-item" role="menuitem" onClick={() => { setActiveMenu(null); setLeftActivity('processes'); }}>
                  <Activity size={14} /><span>进程列表</span>
                </button>
              </div>
            )}
          </div>
        </nav>

        <div className="top-status">
          {activeSession ? `${activeSession.name} · ${activeSession.username}@${activeSession.host}` : ''}
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
        <div className={`left-sidebar${leftActivity ? '' : ' collapsed'}`} style={leftActivity ? { width: `${resourcePanelWidth}%` } : { width: '48px' }}>
          <div className="activity-bar">
            <button
              className={`activity-bar-icon${leftActivity === 'files' ? ' active' : ''}`}
              onClick={() => toggleLeftActivity('files')}
              title="文件浏览器"
            >
              <FolderOpen size={20} />
            </button>
            <button
              className={`activity-bar-icon${leftActivity === 'monitor' ? ' active' : ''}`}
              onClick={() => toggleLeftActivity('monitor')}
              title="资源监控"
            >
              <Activity size={20} />
            </button>
            <button
              className={`activity-bar-icon${leftActivity === 'processes' ? ' active' : ''}`}
              onClick={() => toggleLeftActivity('processes')}
              title="进程管理"
            >
              <ListChecks size={20} />
            </button>
          </div>
          {leftActivity === 'files' && (
        <aside
          className={`file-panel${isDragOver ? ' is-drag-over' : ''}`}
          style={{ gridTemplateRows: `42px auto minmax(0, 1fr) ${resourceBottomPanelHeight}px` }}
          tabIndex={0}
          onKeyDown={handleResourceKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => void handleDrop(e)}
        >
          <div className="file-toolbar">
                <button className="icon-button" title="后退" onClick={navigateBack} disabled={!canNavigateBack || isLoadingFiles}>
                  <ArrowLeft size={17} />
                </button>
                <button className="icon-button" title="前进" onClick={navigateForward} disabled={!canNavigateForward || isLoadingFiles}>
                  <ArrowRight size={17} />
                </button>
                <button className="icon-button" title="上一级" onClick={navigateUp} disabled={!parentPath || isLoadingFiles}>
                  <span className="path-up-glyph">..</span>
                </button>
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
                <button className="icon-button" title="上传文件到当前目录" onClick={triggerFileUpload} disabled={isUploading || isLoadingFiles}>
                  <Upload size={17} />
                </button>
                <button className="icon-button" title="上传文件夹到当前目录" onClick={triggerFolderUpload} disabled={isUploading || isLoadingFiles}>
                  <FolderUp size={17} />
                </button>
                <button className="icon-button" title="刷新" onClick={() => loadResourceDirectory(currentPath || null)} disabled={isLoadingFiles}>
                  <RefreshCw size={17} />
                </button>
                <button className="icon-button" title="全选 (Ctrl+A)" onClick={handleSelectAll} disabled={isLoadingFiles || visibleFiles.length === 0}>
                  <ListChecks size={17} />
                </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void handleFileUpload(e)}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            // @ts-expect-error webkitdirectory is a non-standard attribute
            webkitdirectory=""
            directory=""
            onChange={(e) => void handleFolderUpload(e)}
          />

              <div className="path-breadcrumbs">
                {isEditingPath ? (
                  <div className="path-edit-input-wrap">
                    <input
                      ref={pathEditInputRef}
                      className="path-edit-input"
                      value={pathInput}
                      spellCheck={false}
                      autoFocus
                      onChange={(event) => setPathInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          setIsEditingPath(false);
                          submitPathInput();
                        }
                        if (event.key === 'Escape') {
                          setPathInput(currentPath);
                          setIsEditingPath(false);
                        }
                      }}
                      onBlur={() => {
                        setIsEditingPath(false);
                        setPathInput(currentPath);
                      }}
                      disabled={isLoadingFiles}
                    />
                  </div>
                ) : (
                  <div
                    className="path-breadcrumb-bar"
                    onClick={(e) => {
                      // Only switch to edit mode when clicking the bar background
                      // (not when clicking a breadcrumb button)
                      if (e.target === e.currentTarget) {
                        setPathInput(currentPath);
                        setIsEditingPath(true);
                      }
                    }}
                  >
                    {pathBreadcrumbs.length > 4 && (
                      <button
                        className="path-breadcrumb-ellipsis-btn"
                        title={currentPath}
                        onClick={() => navigateToPath(pathBreadcrumbs[0].path)}
                      >
                        …
                      </button>
                    )}
                    {pathBreadcrumbs.slice(pathBreadcrumbs.length > 4 ? -4 : 0).map((crumb, index) => {
                      const globalIndex = pathBreadcrumbs.length > 4
                        ? pathBreadcrumbs.length - 4 + index
                        : index;
                      const isLast = globalIndex === pathBreadcrumbs.length - 1;
                      return (
                        <button
                          key={crumb.path}
                          className={isLast ? 'path-breadcrumb active' : 'path-breadcrumb'}
                          disabled={isLast}
                          onClick={() => navigateToPath(crumb.path)}
                          title={crumb.path}
                        >
                          <span>{crumb.label}</span>
                          {!isLast && <ChevronRight size={13} />}
                        </button>
                      );
                    })}
                  </div>
                )}
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
                <div className="file-list-body" onContextMenu={handleBlankContextMenu} onClick={(e) => { if (e.target === e.currentTarget) { setSelectedFiles(new Set()); setLastClickedIndex(-1); } }}>
                  {!isLoadingFiles && !fileListError && visibleFiles.map((file, index) => (
                    <button
                      key={file.name}
                      className={`${selectedFiles.has(file.name) ? 'file-item selected' : 'file-item'}${clipboard?.operation === 'cut' && clipboard.paths.includes(file.path) ? ' is-cut' : ''}`}
                      onClick={(e) => handleFileClick(e, file, index)}
                      onDoubleClick={() => openSelectedFile(file)}
                      onContextMenu={(e) => handleFileContextMenu(e, file)}
                    >
                      <span className="file-name">
                        <VscodeFileIcon filename={file.name} isDirectory={file.type === 'directory'} />
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

              <div
                className="resource-bottom-panel"
                ref={resourceBottomPanelRef}
                style={{ height: resourceBottomPanelHeight }}
              >
                <div
                  className="resource-bottom-resizer"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    resourceBottomDragRef.current = { startY: e.clientY, startHeight: resourceBottomPanelHeight };
                  }}
                  onPointerMove={(e) => {
                    const drag = resourceBottomDragRef.current;
                    if (!drag) return;
                    const delta = drag.startY - e.clientY; // 向上拖 = 增大高度
                    const newHeight = Math.max(80, Math.min(drag.startHeight + delta, 500));
                    setResourceBottomPanelHeight(newHeight);
                  }}
                  onPointerUp={() => {
                    resourceBottomDragRef.current = null;
                  }}
                />
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
                  <div className="resource-bottom-content transfer-table-wrap">
                    {transferRecords.length === 0 ? (
                      <div className="resource-bottom-empty">暂无传输任务</div>
                    ) : (
                      <table className="transfer-table">
                        <thead>
                          <tr>
                            <th className="transfer-th-index">序号</th>
                            <th className="transfer-th-name">文件名称</th>
                            <th className="transfer-th-size">文件大小</th>
                            <th className="transfer-th-speed">速度</th>
                            <th className="transfer-th-time">{transferRecords.some(r => r.direction === 'download' || r.direction === 'open') ? '传输时间' : '上传时间'}</th>
                            <th className="transfer-th-action">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transferRecords.map((record, idx) => (
                              <tr key={record.id} className={`transfer-row ${record.status}`}>
                                <td className="transfer-td-index">{idx + 1}</td>
                                <td className="transfer-td-name">
                                  <div className="transfer-name-cell">
                                    <span className="transfer-filename" title={record.fileName}>
                                      {record.direction === 'download' ? <Download size={12} className="transfer-dir-icon" /> : record.direction === 'open' ? <FileText size={12} className="transfer-dir-icon" /> : <Upload size={12} className="transfer-dir-icon" />}
                                      {record.fileName}
                                    </span>
                                    {record.status === 'uploading' && (
                                      <>
                                        {record.progress >= 0 && (
                                          <div className="transfer-progress-bar">
                                            <div className="transfer-progress-fill" style={{ width: `${record.progress}%` }} />
                                          </div>
                                        )}
                                        <span className="transfer-status-msg">{record.message}</span>
                                      </>
                                    )}
                                  </div>
                                </td>
                                <td className="transfer-td-size">
                                  {record.status === 'uploading' && record.progress >= 0 ? (
                                    <span className="transfer-size-progress">
                                      {formatFileSize(record.transferred)} / {formatFileSize(record.size)}
                                    </span>
                                  ) : (
                                    formatFileSize(record.size)
                                  )}
                                </td>
                                <td className="transfer-td-speed">
                                  {record.status === 'uploading' && record.progress >= 0 ? (
                                    <span className="transfer-speed-active">{formatSpeed(record.speed)}</span>
                                  ) : record.status === 'uploading' ? (
                                    <span className="transfer-speed-none">-</span>
                                  ) : record.status === 'success' && record.speed > 0 ? (
                                    <span className="transfer-speed-avg">{formatSpeed(record.speed)}</span>
                                  ) : (
                                    <span className="transfer-speed-none">-</span>
                                  )}
                                </td>
                                <td className="transfer-td-time">{record.time}</td>
                                <td className="transfer-td-action">
                                  {record.status === 'uploading' && (
                                    <button className="transfer-btn transfer-btn-cancel" onClick={() => cancelUpload(record.id)} title="取消上传">
                                      取消上传
                                    </button>
                                  )}
                                  {(record.status === 'success' || record.status === 'failed' || record.status === 'cancelled') && (
                                        <button className={`transfer-btn ${record.status === 'success' ? 'transfer-btn-success' : record.status === 'cancelled' ? 'transfer-btn-cancelled' : 'transfer-btn-delete'}`} onClick={() => deleteTransferRecord(record.id)} title="删除记录">
                                          删除
                                        </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : (
                  <div className="resource-bottom-content resource-log-view">
                    {logEntries.length === 0 ? (
                      <div className="resource-bottom-empty">暂无日志</div>
                    ) : logEntries.map((entry) => (
                      <div key={entry.id} className={`resource-log-line ${entry.level}`}>
                        <span className="resource-log-time">{entry.time}</span>
                        <span className="resource-log-text">{entry.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
        </aside>
        )}
        {leftActivity === 'monitor' && (
          <div className="side-panel">
            <div className="side-panel-header">
              <span>资源监控</span>
            </div>
            {isLoadingMonitor && !monitorData ? (
              <div className="side-panel-loading">
                <RefreshCw size={20} className="spin" />
                <span>正在获取系统信息...</span>
              </div>
            ) : monitorData ? (
              <div className="side-panel-content">
                <div className="monitor-section">
                  <div className="monitor-section-header">
                    <Cpu size={14} />
                    <span>CPU</span>
                    <span className="monitor-value">{Math.max(0, Math.min(100, monitorData.cpu_usage_percent)).toFixed(1)}%</span>
                  </div>
                  <div className="monitor-bar-container">
                    <div className="monitor-bar" style={{ width: `${Math.max(0, Math.min(monitorData.cpu_usage_percent, 100))}%`, background: monitorData.cpu_usage_percent > 80 ? '#e06c75' : monitorData.cpu_usage_percent > 60 ? '#d19a66' : '#98c379' }} />
                  </div>
                  <div className="monitor-detail">{monitorData.cpu_model}</div>
                  <div className="monitor-detail">{monitorData.cpu_count} 核心 · 负载 {monitorData.load_avg_1min.toFixed(2)} / {monitorData.load_avg_5min.toFixed(2)} / {monitorData.load_avg_15min.toFixed(2)}</div>
                </div>

                <div className="monitor-section">
                  <div className="monitor-section-header">
                    <MemoryStick size={14} />
                    <span>内存</span>
                    <span className="monitor-value">{((monitorData.memory_used_bytes / monitorData.memory_total_bytes) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="monitor-bar-container">
                    <div className="monitor-bar" style={{ width: `${Math.min((monitorData.memory_used_bytes / monitorData.memory_total_bytes) * 100, 100)}%`, background: (monitorData.memory_used_bytes / monitorData.memory_total_bytes) * 100 > 80 ? '#e06c75' : (monitorData.memory_used_bytes / monitorData.memory_total_bytes) * 100 > 60 ? '#d19a66' : '#98c379' }} />
                  </div>
                  <div className="monitor-detail">{formatBytes(monitorData.memory_used_bytes)} / {formatBytes(monitorData.memory_total_bytes)}</div>
                  <div className="monitor-detail">可用 {formatBytes(monitorData.memory_available_bytes)}</div>
                </div>

                <div className="monitor-section">
                  <div className="monitor-section-header">
                    <HardDrive size={14} />
                    <span>磁盘</span>
                    <span className="monitor-value">{((monitorData.disk_used_bytes / monitorData.disk_total_bytes) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="monitor-bar-container">
                    <div className="monitor-bar" style={{ width: `${Math.min((monitorData.disk_used_bytes / monitorData.disk_total_bytes) * 100, 100)}%`, background: (monitorData.disk_used_bytes / monitorData.disk_total_bytes) * 100 > 80 ? '#e06c75' : (monitorData.disk_used_bytes / monitorData.disk_total_bytes) * 100 > 60 ? '#d19a66' : '#98c379' }} />
                  </div>
                  <div className="monitor-detail">{formatBytes(monitorData.disk_used_bytes)} / {formatBytes(monitorData.disk_total_bytes)}</div>
                  <div className="monitor-detail">可用 {formatBytes(monitorData.disk_available_bytes)}</div>
                </div>

                <div className="monitor-section">
                  <div className="monitor-section-header">
                    <span>交换空间</span>
                    {monitorData.swap_total_bytes > 0 && <span className="monitor-value">{((monitorData.swap_used_bytes / monitorData.swap_total_bytes) * 100).toFixed(1)}%</span>}
                  </div>
                  {monitorData.swap_total_bytes > 0 ? (
                    <>
                      <div className="monitor-bar-container">
                        <div className="monitor-bar" style={{ width: `${Math.min((monitorData.swap_used_bytes / monitorData.swap_total_bytes) * 100, 100)}%`, background: (monitorData.swap_used_bytes / monitorData.swap_total_bytes) * 100 > 80 ? '#e06c75' : (monitorData.swap_used_bytes / monitorData.swap_total_bytes) * 100 > 60 ? '#d19a66' : '#98c379' }} />
                      </div>
                      <div className="monitor-detail">{formatBytes(monitorData.swap_used_bytes)} / {formatBytes(monitorData.swap_total_bytes)}</div>
                    </>
                  ) : (
                    <div className="monitor-detail">未启用交换空间</div>
                  )}
                </div>

                <div className="monitor-info-grid">
                  <div className="monitor-info-item">
                    <span className="monitor-info-label">主机名</span>
                    <span className="monitor-info-value">{monitorData.hostname}</span>
                  </div>
                  <div className="monitor-info-item">
                    <span className="monitor-info-label">操作系统</span>
                    <span className="monitor-info-value">{monitorData.os_name} {monitorData.os_version}</span>
                  </div>
                  <div className="monitor-info-item">
                    <span className="monitor-info-label">内核版本</span>
                    <span className="monitor-info-value">{monitorData.kernel_version}</span>
                  </div>
                  <div className="monitor-info-item">
                    <span className="monitor-info-label">运行时间</span>
                    <span className="monitor-info-value">{formatUptime(monitorData.uptime_seconds)}</span>
                  </div>
                  <div className="monitor-info-item">
                    <span className="monitor-info-label">进程数</span>
                    <span className="monitor-info-value">{monitorData.processes}</span>
                  </div>
                </div>


              </div>
            ) : (
              <div className="side-panel-empty">
                <Activity size={30} />
                <p>请先连接终端以查看资源监控数据</p>
              </div>
            )}
          </div>
        )}
        {leftActivity === 'processes' && (
          <div className="side-panel">
            <div className="side-panel-header">
              <span>进程管理</span>
              <div className="process-search-box">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="搜索进程..."
                  value={processSearch}
                  onChange={(e) => setProcessSearch(e.target.value)}
                />
              </div>
            </div>
            {isLoadingProcesses && processList.length === 0 ? (
              <div className="side-panel-loading">
                <RefreshCw size={20} className="spin" />
                <span>正在获取进程列表...</span>
              </div>
            ) : processList.length > 0 ? (
              <div className="side-panel-content process-panel-content">
                <div className="process-table">
                  <div className="process-table-header">
                    <div
                      className={`process-col process-col-name${processSortKey === 'name' ? ' sorted' : ''}`}
                      onClick={() => setProcessSortKey('name')}
                    >
                      名称 {processSortKey === 'name' && <ChevronDown size={12} />}
                    </div>
                    <div className="process-col process-col-status">状态</div>
                    <div
                      className={`process-col process-col-cpu${processSortKey === 'cpu' ? ' sorted' : ''}`}
                      onClick={() => setProcessSortKey('cpu')}
                    >
                      CPU {processSortKey === 'cpu' && <ChevronDown size={12} />}
                    </div>
                    <div
                      className={`process-col process-col-mem${processSortKey === 'memory' ? ' sorted' : ''}`}
                      onClick={() => setProcessSortKey('memory')}
                    >
                      内存 {processSortKey === 'memory' && <ChevronDown size={12} />}
                    </div>
                  </div>
                  {(() => {
                    const filtered = processList.filter((p) =>
                      !processSearch || p.name.toLowerCase().includes(processSearch.toLowerCase())
                    );
                    const sorted = [...filtered].sort((a, b) => {
                      if (processSortKey === 'cpu') return b.cpu_usage_percent - a.cpu_usage_percent;
                      if (processSortKey === 'memory') return b.memory_bytes - a.memory_bytes;
                      return a.name.localeCompare(b.name);
                    });
                    return sorted.map((p) => (
                      <div className="process-row" key={p.pid}>
                        <div className="process-col process-col-name" title={p.name}>
                          <span className="process-name">{p.name}</span>
                          <span className="process-pid">({p.pid})</span>
                        </div>
                        <div className="process-col process-col-status">
                          <span className={`process-status-badge status-${p.status.toLowerCase()}`}>
                            {p.status === 'Running' ? '运行' : p.status === 'Sleeping' ? '睡眠' : p.status === 'Idle' ? '空闲' : p.status === 'Zombie' ? '僵尸' : p.status === 'Stopped' ? '停止' : p.status}
                          </span>
                        </div>
                        <div className="process-col process-col-cpu">
                          <span style={{ color: p.cpu_usage_percent > 80 ? '#e06c75' : p.cpu_usage_percent > 60 ? '#d19a66' : '#98c379' }}>
                            {p.cpu_usage_percent.toFixed(1)}%
                          </span>
                        </div>
                        <div className="process-col process-col-mem">
                          {formatBytes(p.memory_bytes)}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            ) : (
              <div className="side-panel-empty">
                <Cpu size={30} />
                <p>请先连接终端以查看进程信息</p>
              </div>
            )}
          </div>
        )}
        </div>

        <div
          className={`resource-resizer${leftActivity ? '' : ' hidden'}`}

          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          onPointerDown={startResourceResize}
        />

        <section className={`terminal-panel${activeTab?.kind === 'terminal' ? ' terminal-panel-terminal-only' : ''}${activeTab?.kind !== 'terminal' && tabs.filter((tab) => !tab.parentTabId).length === 0 ? ' terminal-panel-no-tabs' : ''}`}>
          {activeTab?.kind !== 'terminal' && tabs.filter((tab) => !tab.parentTabId).length > 0 && (
            <div className="workspace-tabs" ref={workspaceTabsRef} onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('.workspace-tab, .workspace-tab-add')) return;
              openNewConnectionTab();
            }}>
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
            {activeTab?.kind === 'terminal' && (showEditor || editorTabs.length > 0) && (
              <div className="workspace-view-toggle">
                <button
                  className={!showEditor ? 'active' : ''}
                  onClick={() => setShowEditor(false)}
                >
                  <TerminalSquare size={14} /> 终端
                </button>
                <button
                  className={showEditor ? 'active' : ''}
                  onClick={() => setShowEditor(true)}
                >
                  <FileText size={14} /> 编辑器
                  {editorTabs.length > 0 && <span className="view-toggle-badge">{editorTabs.length}</span>}
                </button>
              </div>
            )}
            {showEditor && editorTabs.length > 0 ? (
              <EditorPanel
                tabs={editorTabs}
                activeTabId={activeEditorTabId}
                onSelectTab={setActiveEditorTabId}
                onCloseTab={closeEditorTab}
                onSave={saveEditorFile}
                onContentChange={updateEditorContent}
              />
            ) : !activeTab ? (
              <div className="empty-workspace">
                <h2>没有活动标签页</h2>
                <p>点击下方按钮新建连接。</p>
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
                {isLoadingMedia ? (
                  <div className="resource-preview-empty">
                    <Home size={30} />
                    <h2>正在加载媒体...</h2>
                    <p>{selectedFiles.size > 0 ? [...selectedFiles].join(', ') : ''}</p>
                  </div>
                ) : mediaError ? (
                  <div className="resource-preview-empty is-error">
                    <File size={30} />
                    <h2>无法查看媒体</h2>
                    <p>{mediaError}</p>
                  </div>
                ) : mediaViewer ? (
                  <div className="media-viewer">
                    <div className="media-viewer-header">
                      <span className="media-viewer-name">{mediaViewer.name}</span>
                      <button className="media-viewer-close" title="关闭" onClick={() => setMediaViewer(null)}>
                        <X size={16} />
                      </button>
                    </div>
                    <div className="media-viewer-body">
                      {mediaViewer.kind === 'image' && (
                        <img src={mediaViewer.url} alt={mediaViewer.name} className="media-viewer-img" />
                      )}
                      {mediaViewer.kind === 'video' && (
                        <video src={mediaViewer.url} controls autoPlay className="media-viewer-video" />
                      )}
                      {mediaViewer.kind === 'audio' && (
                        <div className="media-viewer-audio-wrap">
                          <audio src={mediaViewer.url} controls autoPlay />
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="resource-preview-empty">
                    <Home size={30} />
                    <h2>{activeTab.session.name} 资源视图</h2>
                    <p>
                      {activeTab.session.id === localSession.id
                        ? '双击文件用内置编辑器打开，双击图片/视频可直接查看。'
                        : '双击远程文件用内置编辑器打开，双击图片/视频可直接查看，双击目录可进入。'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <footer className="status-bar">
            <span title={statusMessage}>{truncateStatus(statusMessage)}</span>
            <span>{tabs.length} 个标签页</span>
          </footer>
        </section>
      </section>

      {/* Connection panel now opens as a separate Tauri window */}

      {contextMenu && (
        <div
          className="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.file ? (
            <>
              {contextMenu.file.type === 'directory' ? (
                <button
                  className="file-context-item"
                  onClick={() => {
                    void loadResourceDirectory(contextMenu.file!.path);
                    setContextMenu(null);
                  }}
                >
                  <FolderOpen size={15} /> 进入目录
                </button>
              ) : (
                <>
                  <button
                    className="file-context-item"
                    onClick={() => {
                      void openFileInEditor(contextMenu.file!);
                      setContextMenu(null);
                    }}
                  >
                    <FileText size={15} /> 内置编辑器打开
                  </button>
                  {getMediaKind(contextMenu.file.name) && (
                    <button
                      className="file-context-item"
                      onClick={() => {
                        const kind = getMediaKind(contextMenu.file!.name);
                        if (kind) void openMediaViewer(contextMenu.file!, kind);
                        setContextMenu(null);
                      }}
                    >
                      <File size={15} /> 查看
                    </button>
                  )}
                </>
              )}
              {contextMenu.file.type === 'file' && isArchive(contextMenu.file.name) && (
                <button
                  className="file-context-item"
                  onClick={() => {
                    void handleExtractArchive(contextMenu.file!);
                    setContextMenu(null);
                  }}
                >
                  <Archive size={15} /> 解压到当前目录
                </button>
              )}
              <button
                className="file-context-item"
                onClick={() => {
                  void handleCreateArchive(contextMenu.file!);
                  setContextMenu(null);
                }}
              >
                <FileArchive size={15} /> 压缩为 ZIP
              </button>
              {contextMenu.file.type === 'file' && !isLocalResourceTab(activePaneTabRef.current) && (
                <button
                  className="file-context-item"
                  onClick={() => {
                    void downloadFileToLocal(contextMenu.file!);
                    setContextMenu(null);
                  }}
                >
                  <Download size={15} /> 下载到本地
                </button>
              )}
              <div className="file-context-divider" />
              <button
                className="file-context-item"
                onClick={() => {
                  // Copy all selected items if the right-clicked file is part
                  // of the selection; otherwise copy just the clicked file.
                  const selected = getSelectedResourceFiles();
                  const isMulti = selected.length > 1 && selectedFiles.has(contextMenu.file!.name);
                  handleCopyFiles(isMulti ? selected : [contextMenu.file!]);
                  setContextMenu(null);
                }}
              >
                <Clipboard size={15} /> 复制{selectedFiles.size > 1 && selectedFiles.has(contextMenu.file!.name) ? ` (${selectedFiles.size} 个)` : ''}
              </button>
              <button
                className="file-context-item"
                onClick={() => {
                  const selected = getSelectedResourceFiles();
                  const isMulti = selected.length > 1 && selectedFiles.has(contextMenu.file!.name);
                  handleCutFiles(isMulti ? selected : [contextMenu.file!]);
                  setContextMenu(null);
                }}
              >
                <Scissors size={15} /> 剪切{selectedFiles.size > 1 && selectedFiles.has(contextMenu.file!.name) ? ` (${selectedFiles.size} 个)` : ''}
              </button>
              <button
                className="file-context-item"
                onClick={() => {
                  void openRenameDialog(contextMenu.file!);
                  setContextMenu(null);
                }}
              >
                <FileText size={15} /> 重命名
              </button>
              <button
                className="file-context-item danger"
                onClick={() => {
                  const selected = getSelectedResourceFiles();
                  const isMulti = selected.length > 1 && selectedFiles.has(contextMenu.file!.name);
                  void handleDeletePaths(isMulti ? selected : [contextMenu.file!]);
                  setContextMenu(null);
                }}
              >
                <Trash2 size={15} /> 删除{selectedFiles.size > 1 && selectedFiles.has(contextMenu.file!.name) ? ` (${selectedFiles.size} 个)` : ''}
              </button>
            </>
          ) : (
            <>
              {clipboard && (
                <button
                  className="file-context-item"
                  onClick={() => {
                    void handlePasteFile();
                    setContextMenu(null);
                  }}
                >
                  <ClipboardPaste size={15} /> 粘贴{clipboard.paths.length > 1 ? ` (${clipboard.paths.length} 个)` : ''}
                </button>
              )}
              <button
                className="file-context-item"
                onClick={() => {
                  openNewItemDialog('file');
                  setContextMenu(null);
                }}
              >
                <FilePlus size={15} /> 新建文件
              </button>
              <button
                className="file-context-item"
                onClick={() => {
                  openNewItemDialog('directory');
                  setContextMenu(null);
                }}
              >
                <FolderPlus size={15} /> 新建文件夹
              </button>
            </>
          )}
        </div>
      )}

      {newItemDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setNewItemDialog(null)}>
          <div className="dialog-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{newItemDialog.type === 'file' ? '新建文件' : '新建文件夹'}</h3>
            <input
              autoFocus
              className="dialog-input"
              value={newItemName}
              placeholder={newItemDialog.type === 'file' ? '输入文件名' : '输入文件夹名'}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNewItem();
                if (e.key === 'Escape') setNewItemDialog(null);
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setNewItemDialog(null)}>取消</button>
              <button className="dialog-btn primary" onClick={() => void handleCreateNewItem()}>确定</button>
            </div>
          </div>
        </div>
      )}

      {renameDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setRenameDialog(null)}>
          <div className="dialog-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3>重命名</h3>
            <input
              autoFocus
              className="dialog-input"
              value={renameValue}
              placeholder="输入新名称"
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename();
                if (e.key === 'Escape') setRenameDialog(null);
              }}
            />
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setRenameDialog(null)}>取消</button>
              <button className="dialog-btn primary" onClick={() => void handleRename()}>确定</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;