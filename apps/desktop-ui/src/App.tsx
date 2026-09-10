import { listen } from '@tauri-apps/api/event';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  addLogEntry,
  addTransferRecord,
  addTransferRecords,
  getTransferLogSnapshot,
  setStatusMessage,
  updateTransferRecord,
} from './appShellStore';
import { EditorPanel, detectLanguage, type EditorTab } from './EditorPanel';
import { scrollHorizontallyOnWheel } from './wheelScroll';
import { VscodeFileIcon } from './FileIcon';
import { ResourceBottomPanel } from './ResourceBottomPanel';
import { StatusBar } from './StatusBar';
import {
  RESOURCE_RENAME_SECOND_CLICK_DELAY_MS,
  buildPathBreadcrumbs,
  clampPanelWidth,
  compareResource,
  formatFileSize,
  formatModifiedTime,
  getMediaKind,
  isArchive,
  isUploadConflictRenameInvalid,
  joinRemotePath,
  splitUploadRelativePath,
  toResourceFile,
  type InlineRenameState,
  type ResourceFile,
  type ResourceSortKey,
} from './resourceModel';
import {
  TERMINAL_PANE_EDGE_DROP_RATIO,
  TERMINAL_TAB_DRAG_THRESHOLD,
  activateTerminalPaneTab,
  addTerminalTabToPane,
  clampSplitRatio,
  collectTerminalLayoutTabIds,
  createDefaultTerminalLayout,
  findLeafTabGroup,
  findTerminalWorkspaceOwner,
  getLeafTabIds,
  insertTerminalPane,
  removeTerminalPane,
  removeTerminalTabFromPane,
  reorderPaneTabIds,
  terminalLayoutContainsSplit,
  updateTerminalSplitRatio,
  type TerminalActivityEntry,
  type TerminalDragState,
  type TerminalDropSide,
  type TerminalLayoutNode,
  type TerminalPointerDragCandidate,
  type TerminalReorderPlacement,
  type TerminalSizeSnapshot,
  type TerminalSplitDirection,
  type TerminalSplitResizeCandidate,
  type WorkspaceTab,
} from './terminalLayout';
import { TopMenubar } from './TopMenubar';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Pencil,
  Download,
  Eye,
  EyeOff,
  File,
  FileText,
  FolderOpen,
  Home,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Monitor,
  Settings,
  TerminalSquare,
  Eraser,
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
  Bot,
  Cpu,
  CornerDownLeft,
  HardDrive,
  MemoryStick,
  Paperclip,
  Sparkles,
  Square,
  RotateCcw,
  MessageSquarePlus,
  Store,
  Zap,
} from 'lucide-react';
import { AiMarkdown } from './AiMarkdown';
import {
  connectSession,
  disconnectSession,
  getLocalTerminalProfile,
  getAiProviderConfig,
  saveAiProviderConfig,
  syncAiProviderModels,
  testAiProvider,
  addAiProviderAccount,
  deleteAiProviderAccount,
  setActiveAiProviderAccount,
  getMcpConfig,
  saveMcpConfig,
  reconnectMcpServer,
  listMcpTools,
  callMcpTool,
  listMcpImportCandidates,
  importMcpServersFromPath,
  exportMcpServersCursorJson,
  streamAiChat,
  stopAiChat,
  listAiConversations,
  saveAiConversation,
  deleteAiConversation,
  runAiTerminalCommand,
  type McpServerConfig,
  type McpConfigSnapshot,
  type McpImportCandidate,
  listLocalDirectory,
  listRemoteDirectory,
  readLocalFileFull,
  readRemoteFileFull,
  writeLocalFile,
  writeRemoteFile,
  writeLocalFileChecked,
  writeRemoteFileChecked,
  uploadFile,
  uploadLocalFile,
  cancelTransfer,
  uploadDirectory,
  downloadRemoteFile,
  extractArchive,
  createArchive,
  deletePath,
  createFile,
  createDirectory,
  copyPath,
  movePath,
  getUploadConcurrency,
  resizeLocalTerminal,
  resizeTerminal,
  readClipboardText,
  writeClipboardText,
  sendLocalTerminalInput,
  startLocalTerminal,
  stopLocalTerminal,
  terminalWrite,
  openConnectionWindow,
  openAiSettingsWindow,
  preloadConnectionWindows,
} from './api';
import type { AiChatStreamEvent, AiProviderConfig, LocalDirectoryListing, LocalTerminalProfile, Session, TerminalOutputEvent, TerminalStatusEvent } from './api';
import { useSystemMonitor } from './useSystemMonitor';
import { useMediaViewer } from './useMediaViewer';
import { useUploadConflict } from './useUploadConflict';
import { RdpView } from './RdpView';
import {
  applyTerminalLifecycleState,
  reconnectDelayMs,
  shouldApplyTerminalStatus,
  shouldReconnect,
  terminalLifecycleMessage,
} from './terminalLifecycle';
import {
  prepareTerminalPaste,
  formatTerminalPasteSize,
  type PreparedTerminalPaste,
} from './terminalPaste';
import {
  applyExactEdits,
  parseAiEditResponse,
  summarizeEditDelta,
  type AiEditProposal,
} from './aiEditProposal';
import {
  isHighRiskTerminalCommand,
  parseAiTerminalResponse,
  suspiciousShellRedirection,
  terminalCommandIdentity,
  type AiTerminalAction,
} from './aiTerminalAction';
import {
  mcpActionIdentity,
  parseAiMcpResponse,
  type AiMcpAction,
} from './aiMcpAction';
import {
  mapNativeToolCalls,
  type AiNativeToolCall,
} from './aiToolCall';
import {
  createAiConversationState,
  fromStoredAiConversation,
  toStoredAiConversation,
  type AiContextItem,
  type AiContextKind,
  type AiConversationMode,
  type AiConversationState,
  type AiMessage,
} from './aiRuntime';
import {
  MCP_MARKET_CATALOG,
  MCP_MARKET_CATEGORIES,
  filterMcpMarketItems,
  marketItemToServerConfig,
  mcpMarketCategoryLabel,
  type McpMarketCategoryId,
  type McpMarketItem,
} from './mcpMarketplace';
import {
  AI_AGENT_MAX_CONTINUATIONS,
  AI_AGENT_RESULT_LABEL_PREFIX,
  AI_EMPTY_SUGGESTIONS,
  AI_MODE_OPTIONS,
  AI_REASONING_EFFORT_OPTIONS,
  buildAgentContinuationPrompt,
  buildAiRequestMessages,
  canContinueAiAgent,
  estimateAiContextUsage,
  formatAiContextAmount,
  formatMcpToolsCatalog,
  isAiAgentContinuationMessage,
  normalizeAiReasoningEffort,
  resolveAiChatModelOptions,
  type AiReasoningEffort,
} from './aiChatModel';
import {
  type AiConfigDraft,
  createEmptyMcpServer,
  countEnabledMcpTools,
  formatMcpServerCommandLine,
  formatMcpServerJson,
  isAiConfigDraftDirty,
  isMcpServerDraftDirty,
  isMcpServersDraftDirty,
  isMcpToolDisabled,
  mergeMcpServerImports,
  mcpServerAvatarLetter,
  mcpServerStatusDot,
  mcpStatusLabel,
  parseMcpServerJsonText,
  resolveAiModelCatalog,
  resolveAiTestModel,
  buildAiProviderTestLog,
  aiConfigToDraft,
  aiConfigToProviderState,
  DEFAULT_AI_CONFIG_DRAFT,
  snapshotToMcpDraft,
  toggleMcpToolDisabled,
  AI_API_FORMAT_OPTIONS,
  normalizeAiApiFormat,
} from './aiSettingsModel';
import { SelectDropdown } from './SelectDropdown';
import {
  clampFloatingMenuLeft,
  measureFloatingMenuAnchor,
  type FloatingMenuAnchor,
} from './floatingMenu';
import {
  fallbackLocalTerminalProfile,
  localSession,
  oneDarkProTerminalTheme,
} from './appEnvironment';

const isAiSettingsWindow = false;
const initialAiSettingsTab: 'models' | 'mcp' = 'models';

export function App() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** 左侧栏宽度：拖动中只改 DOM，pointerup 再 commit 一次 */
  const [resourcePanelWidth, setResourcePanelWidth] = useState(40);
  const resourcePanelWidthRef = useRef(40);
  const leftSidebarRef = useRef<HTMLDivElement | null>(null);
  const sessionContentRef = useRef<HTMLElement | null>(null);
  // Left-side activity bar state — which panel is open
  const [leftActivity, setLeftActivity] = useState<'files' | 'monitor' | 'processes' | 'ai' | null>('files');

  const [aiWorkspace, setAiWorkspace] = useState(() => {
    const conversation = createAiConversationState();
    return { conversations: [conversation], activeConversationId: conversation.id };
  });
  const aiWorkspaceRef = useRef(aiWorkspace);
  aiWorkspaceRef.current = aiWorkspace;
  const aiConversations = aiWorkspace.conversations;
  const activeAiConversation = aiConversations.find((conversation) => conversation.id === aiWorkspace.activeConversationId)
    ?? aiConversations[0];
  const aiMessages = activeAiConversation?.messages ?? [];
  const aiMessageListRef = useRef<HTMLDivElement | null>(null);
  /** 标记本次定位属于“打开面板 / 切换会话 / 载入历史”，应瞬时落到底部而不是平滑滚动 */
  const aiInstantScrollRef = useRef(false);
  useLayoutEffect(() => {
    const messageList = aiMessageListRef.current;
    if (!messageList) return;
    messageList.scrollTop = messageList.scrollHeight;
    // 随后的消息 effect 还会再滚一次，这里标记掉，避免 smooth 造成“从头滚到尾”的观感
    aiInstantScrollRef.current = true;
  }, [activeAiConversation?.id]);
  const [aiInput, setAiInput] = useState('');
  /** AI 主输入框：按内容撑高，上限后内部滚动 */
  const aiInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null);
  const [editingUserMessageDraft, setEditingUserMessageDraft] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const [aiConfigDraft, setAiConfigDraft] = useState<AiConfigDraft>({
    ...DEFAULT_AI_CONFIG_DRAFT,
  });
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(isAiSettingsWindow);
  /** 设置弹窗分区：Models（供应商/模型）| MCP（Cursor 风格服务器列表） */
  const [aiSettingsTab, setAiSettingsTab] = useState<'models' | 'mcp'>(initialAiSettingsTab);
  /** Cursor 设置左侧导航过滤 */
  const [aiSettingsNavQuery, setAiSettingsNavQuery] = useState('');
  /** Models 列表过滤（长列表） */
  const [aiModelListQuery, setAiModelListQuery] = useState('');
  const [aiSettingsApiKeysOpen, setAiSettingsApiKeysOpen] = useState(true);
  const [isAiConfigLoading, setIsAiConfigLoading] = useState(false);
  const [isAiConfigSaving, setIsAiConfigSaving] = useState(false);
  const [isAiModelsSyncing, setIsAiModelsSyncing] = useState(false);
  const [aiTestModel, setAiTestModel] = useState('');
  const [isAiProviderTesting, setIsAiProviderTesting] = useState(false);
  const [aiProviderTestDialog, setAiProviderTestDialog] = useState<{
    open: boolean;
    lines: string[];
    status: 'idle' | 'running' | 'done' | 'error';
  }>({ open: false, lines: [], status: 'idle' });
  const [aiConfigError, setAiConfigError] = useState('');
  const [isAiApiKeyVisible, setIsAiApiKeyVisible] = useState(false);
  /** 设置弹窗内 API Key 草稿（可回填展示；关闭后清空） */
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('');
  const aiApiKeyBaselineRef = useRef('');
  const aiApiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const isAiSettingsOpenRef = useRef(false);
  const openAiSettingsRef = useRef<(tab?: 'models' | 'mcp') => void>(() => {});
  const requestCloseAiSettingsRef = useRef<() => void>(() => {});
  isAiSettingsOpenRef.current = isAiSettingsOpen;
  const aiConfigRefreshGenerationRef = useRef(0);
  /** MCP 设置：草稿 + 运行时快照（status/tools） */
  const [mcpServersDraft, setMcpServersDraft] = useState<McpServerConfig[]>([]);
  const [mcpSnapshot, setMcpSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [isMcpLoading, setIsMcpLoading] = useState(false);
  const [isMcpSaving, setIsMcpSaving] = useState(false);
  const [mcpBusyServerId, setMcpBusyServerId] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState('');
  const [mcpNotice, setMcpNotice] = useState('');
  const [expandedMcpServerId, setExpandedMcpServerId] = useState<string | null>(null);
  /** 编辑框中的 JSON 文本（按 server id） */
  const [mcpEditJsonById, setMcpEditJsonById] = useState<Record<string, string>>({});
  const [mcpEditJsonErrorById, setMcpEditJsonErrorById] = useState<Record<string, string>>({});
  /** 工具标签 Show more */
  const [mcpToolsExpandedIds, setMcpToolsExpandedIds] = useState<Record<string, boolean>>({});
  /** Cursor mcp.json 导入面板 */
  const [mcpImportOpen, setMcpImportOpen] = useState(false);
  const [mcpImportCandidates, setMcpImportCandidates] = useState<McpImportCandidate[]>([]);
  const [mcpImportPath, setMcpImportPath] = useState('');
  /** 同 id：覆盖或跳过 */
  const [mcpImportStrategy, setMcpImportStrategy] = useState<'overwrite' | 'skip'>('overwrite');
  const [isMcpImporting, setIsMcpImporting] = useState(false);
  const [isMcpExporting, setIsMcpExporting] = useState(false);
  /** MCP 页内：已安装 | 市场 */
  const [mcpPane, setMcpPane] = useState<'installed' | 'market'>('installed');
  const [mcpMarketQuery, setMcpMarketQuery] = useState('');
  const [mcpMarketCategory, setMcpMarketCategory] = useState<McpMarketCategoryId>('all');
  const mcpRefreshGenerationRef = useRef(0);
  const [pendingAiContexts, setPendingAiContexts] = useState<AiContextItem[]>([]);
  const [isAiMentionOpen, setIsAiMentionOpen] = useState(false);
  /** 输入区模式/模型/推理强度/上下文菜单：Cursor 风格自定义下拉 */
  const [aiComposerMenu, setAiComposerMenu] = useState<null | 'mode' | 'model' | 'effort' | 'context'>(null);
  const [aiComposerMenuAnchor, setAiComposerMenuAnchor] = useState<FloatingMenuAnchor | null>(null);
  /** Agent：低风险终端/MCP 提案后自动执行（高风险与文件修改仍须确认） */
  const [aiAutoRunEnabled, setAiAutoRunEnabled] = useState(() => {
    try {
      return window.localStorage.getItem('pandaterm.ai.autoRun') === '1';
    } catch {
      return false;
    }
  });
  const aiAutoRunEnabledRef = useRef(aiAutoRunEnabled);
  aiAutoRunEnabledRef.current = aiAutoRunEnabled;
  /** 生成中排队的用户消息（发送时若正在生成则入队） */
  const [aiMessageQueue, setAiMessageQueue] = useState<Array<{
    id: string;
    content: string;
    contexts: AiContextItem[];
  }>>([]);
  const [aiConversationError, setAiConversationError] = useState('');
  const aiConversationsLoadedRef = useRef(false);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const aiActiveRequestRef = useRef<{
    requestId: string;
    conversationId: string;
    assistantMessageId: string;
    userMessageId: string;
    mode: AiConversationMode;
    content: string;
    toolCalls: AiNativeToolCall[];
    protocolRepairAttempt: boolean;
  } | null>(null);
  const finishAiStreamRef = useRef<(
    activeRequest: NonNullable<typeof aiActiveRequestRef.current>,
    status: 'complete' | 'cancelled' | 'error',
    errorMessage?: string,
  ) => void>(() => undefined);
  const runAiTerminalActionRef = useRef<(
    conversationId: string,
    messageId: string,
    action: AiTerminalAction,
  ) => void>(() => undefined);
  const runAiMcpActionRef = useRef<(
    conversationId: string,
    messageId: string,
    action: AiMcpAction,
  ) => Promise<void>>(async () => undefined);
  const flushAiMessageQueueRef = useRef<() => void>(() => undefined);
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
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null);
  const lastPlainFileClickRef = useRef<{ path: string; at: number } | null>(null);
  const pendingInlineRenameTimerRef = useRef<number | null>(null);
  const [sortKey, setSortKey] = useState<ResourceSortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  /** 递增以唤起底部面板本地终端 */
  const [openLocalTerminalKey, setOpenLocalTerminalKey] = useState(0);
  const [clipboard, setClipboard] = useState<{ paths: string[]; operation: 'copy' | 'cut'; terminalId: string | null } | null>(null);
  const [newItemDialog, setNewItemDialog] = useState<{ type: 'file' | 'directory' } | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [renameDialog, setRenameDialog] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const {
    uploadConflictDialog,
    setUploadConflictDialog,
    requestUploadConflictDecision,
    resolveUploadConflictDialog,
  } = useUploadConflict();

  useEffect(() => {
    if (!inlineRename || inlineRename.submitting) return;
    const frameId = window.requestAnimationFrame(() => {
      const input = inlineRenameInputRef.current;
      if (!input) return;
      input.focus();
      const extensionIndex = inlineRename.type === 'file' ? inlineRename.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : inlineRename.value.length);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [inlineRename?.path, inlineRename?.submitting]);

  useEffect(() => {
    const cancelPendingRenameOutsideFileRow = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.file-item')) return;
      if (pendingInlineRenameTimerRef.current !== null) {
        window.clearTimeout(pendingInlineRenameTimerRef.current);
        pendingInlineRenameTimerRef.current = null;
      }
      lastPlainFileClickRef.current = null;
    };
    window.addEventListener('pointerdown', cancelPendingRenameOutsideFileRow, true);
    return () => {
      window.removeEventListener('pointerdown', cancelPendingRenameOutsideFileRow, true);
      if (pendingInlineRenameTimerRef.current !== null) {
        window.clearTimeout(pendingInlineRenameTimerRef.current);
      }
    };
  }, []);

  // AI 输入区模式/模型自定义菜单：点击外部或 Esc 关闭
  useEffect(() => {
    if (!aiComposerMenu) return;
    const closeComposerMenu = () => {
      setAiComposerMenu(null);
      setAiComposerMenuAnchor(null);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.ai-composer-menu') && !target.closest('.ai-composer-popover')) {
        closeComposerMenu();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeComposerMenu();
    };
    // 窗口缩放 / 外部滚动时关闭；菜单自身滚动不关
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.ai-composer-popover')) return;
      closeComposerMenu();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', closeComposerMenu);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', closeComposerMenu);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [aiComposerMenu]);

  // Cursor 风格：输入框随内容增高，清空/程序改值时同步收起
  useEffect(() => {
    const el = aiInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [aiInput]);

  useEffect(() => {
    if (isAiSettingsOpen) return;
    setIsAiApiKeyVisible(false);
    setAiApiKeyDraft('');
    aiApiKeyBaselineRef.current = '';
    setAiModelListQuery('');
    setMcpImportOpen(false);
    setMcpImportCandidates([]);
    setMcpImportPath('');
    setMcpImportStrategy('overwrite');
    setIsMcpImporting(false);
    setMcpPane('installed');
    setMcpMarketQuery('');
    setMcpMarketCategory('all');
    setIsMcpExporting(false);
    setMcpNotice('');
  }, [isAiSettingsOpen]);

  // Esc 关闭 AI 设置（有其它对话框或保存中时不关；有脏草稿时确认）
  // 注意：requestCloseAiSettings 在组件后部声明，函数声明会在 App 作用域内提升
  useEffect(() => {
    if (!isAiSettingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting || isMcpSaving || mcpBusyServerId) return;
      if (aiProviderTestDialog.open) {
        event.preventDefault();
        setAiProviderTestDialog({ open: false, lines: [], status: 'idle' });
        return;
      }
      if (confirmDialog || uploadConflictDialog || newItemDialog || renameDialog) return;
      event.preventDefault();
      requestCloseAiSettings();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isAiSettingsOpen,
    isAiConfigSaving,
    isAiModelsSyncing,
    isAiProviderTesting,
    isMcpSaving,
    mcpBusyServerId,
    confirmDialog,
    uploadConflictDialog,
    newItemDialog,
    renameDialog,
    aiProviderTestDialog.open,
    aiConfigDraft,
    aiApiKeyDraft,
    aiProviderConfig,
    mcpServersDraft,
    mcpSnapshot,
  ]);

  // 左侧导航过滤：当前 tab 被滤掉时自动切到第一个可见项
  useEffect(() => {
    if (!isAiSettingsOpen) return;
    const q = aiSettingsNavQuery.trim().toLowerCase();
    const items = ([
      { id: 'models' as const, label: '模型设置' },
      { id: 'mcp' as const, label: 'MCP服务器' },
    ]).filter((item) => !q || item.label.toLowerCase().includes(q) || item.id.includes(q));
    if (items.length > 0 && !items.some((item) => item.id === aiSettingsTab)) {
      setAiSettingsTab(items[0].id);
    }
  }, [isAiSettingsOpen, aiSettingsNavQuery, aiSettingsTab]);

  const [pendingPaneTabId, setPendingPaneTabId] = useState<string | null>(null);
  const pendingPaneTabIdRef = useRef(pendingPaneTabId);
  pendingPaneTabIdRef.current = pendingPaneTabId;
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const editorTabsRef = useRef<EditorTab[]>(editorTabs);
  editorTabsRef.current = editorTabs;
  const [activeEditorTabId, setActiveEditorTabId] = useState<string | null>(null);
  /** 编辑器宿主 pane：编辑器固定在打开它的 pane，不随终端焦点切换而搬家 */
  /** 各 workspace 已知 pane 集合：用于检测 pane 被移除（合并分屏/关终端），把归属它的文件标签改为无归属 */
  const knownPaneIdsByWorkspaceRef = useRef<Map<string, Set<string>>>(new Map());
  const untitledEditorCounterRef = useRef(1);
  const [showEditor, setShowEditor] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: ResourceFile | null } | null>(null);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; tabId: string; selection: string } | null>(null);
  const [pendingTerminalPaste, setPendingTerminalPaste] = useState<(PreparedTerminalPaste & { tabId: string }) | null>(null);
  const terminalPasteInFlightRef = useRef(new Set<string>());
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  /** 嵌套 dragenter/leave 深度，避免子节点抖动误关遮罩 */
  const resourceDragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const pathEditInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRefs = useRef<Map<string, AbortController>>(new Map());
  const editorSaveGenerationRef = useRef<Map<string, number>>(new Map());
  /** 正在保存中的编辑器 tab：避免并发保存时旧内容后落盘覆盖新内容 */
  const editorSavingIdsRef = useRef<Set<string>>(new Set());
  /** 保存期间又产生的改动：当前这次结束后再补存一次 */
  const editorPendingSaveRef = useRef<Set<string>>(new Set());
  /** seconds 用 DOM 刷新，避免连接中每秒整 App 重渲 */
  const [openingConnection, setOpeningConnection] = useState<{ session: Session; tabId: string; startedAt: number } | null>(null);
  const openingSecondsRef = useRef<HTMLSpanElement | null>(null);
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
  const lastPaneTabClickRef = useRef<{ tabId: string; at: number } | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const cancelledConnectionTabIdsRef = useRef<Set<string>>(new Set());
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Track which terminal_ids have been started on the backend to avoid double-start
  const startedTerminalsRef = useRef<Set<string>>(new Set());
  // Map backend terminal_id → tab id, set immediately when startLocalTerminal resolves.
  // Bridges the gap between PTY output arriving and setTabs flushing the real terminalId.
  const terminalIdToTabIdRef = useRef<Map<string, string>>(new Map());
  const pendingOutputRef = useRef<Map<string, string[]>>(new Map());
  const pendingTerminalStatusRef = useRef<Map<string, TerminalStatusEvent>>(new Map());
  const retiredTerminalIdsRef = useRef<Set<string>>(new Set());
  const currentPathRef = useRef('');
  const resourceFilesRef = useRef<ResourceFile[]>([]);
  // Per-pane navigation history: each terminal pane keeps its own back/forward
  // stack so switching between local and remote panes restores the right trail.
  const navHistoryRef = useRef<Map<string, { history: string[]; index: number }>>(new Map());
  const directoryLoadGenerationRef = useRef(0);

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
      void resizeLocalTerminal(tab.terminalId, terminal.cols, terminal.rows).catch(() => {});
    } else {
      void resizeTerminal(tab.terminalId, terminal.cols, terminal.rows).catch(() => {});
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

  function createActivity(level: TerminalActivityEntry['level'], text: string): TerminalActivityEntry {
    return {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      level,
      text,
    };
  }

  function consumePendingTerminalOutput(terminalId: string, tabId: string) {
    const pendingPayloads = pendingOutputRef.current.get(terminalId);
    if (!pendingPayloads || pendingPayloads.length === 0) return;
    pendingOutputRef.current.delete(terminalId);

    setTabs((current) => current.map((item) => item.id === tabId
      ? { ...item, output: [...item.output, ...pendingPayloads].slice(-500) }
      : item));

    const term = terminalsRef.current.get(tabId);
    for (const payload of pendingPayloads) {
      term?.write(payload);
    }
  }

  function scheduleTerminalReconnect(tabId: string) {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || tab.kind !== 'terminal' || tab.closedByUser || !tab.terminalId) return;
    if (!shouldReconnect(tab.status, tab.session.reconnect, false, tab.reconnectAttempts)) return;
    if (reconnectTimersRef.current.has(tabId)) return;

    const attempt = tab.reconnectAttempts + 1;
    const delay = reconnectDelayMs(tab.session.reconnect, tab.reconnectAttempts);
    setTabs((current) => current.map((item) => item.id === tabId
      ? {
        ...item,
        status: 'reconnecting',
        reconnectAttempts: attempt,
        statusMessage: `连接已断开，${delay / 1000} 秒后重连（${attempt}/${tab.session.reconnect.max_attempts}）`,
      }
      : item));

    const timer = setTimeout(() => {
      reconnectTimersRef.current.delete(tabId);
      const current = tabsRef.current.find((item) => item.id === tabId);
      if (!current || current.closedByUser || !current.terminalId) return;
      void connectSession(current.session.id, current.terminalId).catch((error) => {
        applyTerminalStatusToTab({
          terminal_id: current.terminalId,
          transport: 'remote',
          state: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }, tabId);
      });
    }, delay);
    reconnectTimersRef.current.set(tabId, timer);
  }

  function applyTerminalStatusToTab(event: TerminalStatusEvent, tabId: string) {
    const message = terminalLifecycleMessage(event);
    const sessionName = tabsRef.current.find((item) => item.id === tabId)?.session.name
      ?? event.transport;

    setTabs((current) => current.map((item) => {
      if (item.id !== tabId) return item;
      const nextStatus = applyTerminalLifecycleState(item.status, event.state);
      if (nextStatus === item.status && item.statusMessage === message) return item;
      return {
        ...item,
        terminalId: item.terminalId || event.terminal_id,
        status: nextStatus,
        statusMessage: message,
        activityLog: [
          ...item.activityLog,
          createActivity(event.state === 'failed' ? 'error' : 'info', message),
        ].slice(-20),
      };
    }));

    setOpeningConnection((current) => current?.tabId === tabId ? null : current);
    setStatusMessage(`${event.state === 'failed' ? '连接失败' : message}：${sessionName}`);
    if (event.transport === 'remote' && (event.state === 'failed' || event.state === 'disconnected')) {
      scheduleTerminalReconnect(tabId);
    }
    if (event.state === 'connected') {
      reconnectTimersRef.current.delete(tabId);
      setTabs((current) => current.map((item) => item.id === tabId ? { ...item, reconnectAttempts: 0 } : item));
    }
  }

  function consumePendingTerminalStatus(terminalId: string, tabId: string) {
    const pendingStatus = pendingTerminalStatusRef.current.get(terminalId);
    if (!pendingStatus) return false;
    pendingTerminalStatusRef.current.delete(terminalId);
    applyTerminalStatusToTab(pendingStatus, tabId);
    return true;
  }

  function cancelUpload(id: string) {
    const abortCtrl = uploadAbortRefs.current.get(id);
    if (abortCtrl) {
      abortCtrl.abort();
      uploadAbortRefs.current.delete(id);
    }
    // 仅真正开传后才调后端取消；排队中的只本地标记
    const row = getTransferLogSnapshot().transferRecords.find((item) => item.id === id);
    if (row?.status === 'uploading') {
      void cancelTransfer(id).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        addLogEntry('error', `取消传输失败：${message}`);
      });
    }
    updateTransferRecord(id, { status: 'cancelled', message: '已取消' });
    addLogEntry('warn', '传输已取消');
  }

  function retireTerminalId(terminalId: string) {
    retiredTerminalIdsRef.current.add(terminalId);
    if (retiredTerminalIdsRef.current.size > 512) {
      const oldestTerminalId = retiredTerminalIdsRef.current.values().next().value;
      if (oldestTerminalId) retiredTerminalIdsRef.current.delete(oldestTerminalId);
    }
    pendingOutputRef.current.delete(terminalId);
    pendingTerminalStatusRef.current.delete(terminalId);
  }

  function disposeTerminalRuntime(tab: WorkspaceTab) {
    const reconnectTimer = reconnectTimersRef.current.get(tab.id);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimersRef.current.delete(tab.id);
    }
    setPendingTerminalPaste((current) => current?.tabId === tab.id ? null : current);
    setTerminalContextMenu((current) => current?.tabId === tab.id ? null : current);
    terminalPasteInFlightRef.current.delete(tab.id);

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
      retireTerminalId(tab.terminalId);
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

  function createRdpTab(session: Session, parentTabId?: string): WorkspaceTab {
    const tabId = `rdp:${session.id}-${crypto.randomUUID()}`;
    return {
      id: tabId,
      kind: 'rdp',
      session,
      title: session.name,
      terminalId: crypto.randomUUID(),
      status: 'connecting',
      output: [],
      statusMessage: '正在连接远程桌面...',
      closedByUser: false,
      reconnectAttempts: 0,
      activityLog: [createActivity('info', '正在连接远程桌面...')],
      layout: createDefaultTerminalLayout(tabId),
      activePaneId: tabId,
      parentTabId,
    };
  }

  function openRdpTab(session: Session) {
    const nextTab = createRdpTab(session);
    activeTabRef.current = nextTab;
    activeTabIdRef.current = nextTab.id;
    setShowEditor(false);
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    setStatusMessage(`正在连接远程桌面 ${session.username}@${session.host}:${session.port}`);
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
      closeMediaViewer();
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
    const paneKey = tab?.id ?? '__local__';
    const requestGeneration = ++directoryLoadGenerationRef.current;
    const isCurrentRequest = () => {
      const currentTab = activePaneTabRef.current;
      return directoryLoadGenerationRef.current === requestGeneration
        && (currentTab?.id ?? '__local__') === paneKey;
    };
    const local = isLocalResourceTab(tab);
    setInlineRename(null);
    lastPlainFileClickRef.current = null;
    if (pendingInlineRenameTimerRef.current !== null) {
      window.clearTimeout(pendingInlineRenameTimerRef.current);
      pendingInlineRenameTimerRef.current = null;
    }
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
      if (!isCurrentRequest()) return;

      const nextFiles = listing.entries.map(toResourceFile);
      setCurrentPath(listing.path);
      setPathInput(listing.path);
      setParentPath(listing.parent ?? null);
      setResourceFiles(nextFiles);
      currentPathRef.current = listing.path;
      resourceFilesRef.current = nextFiles;
      setSelectedFiles(new Set());
      setLastClickedIndex(-1);
      closeMediaViewer();

      // Update per-pane navigation history.
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
      if (!isCurrentRequest()) return;
      const message = error instanceof Error ? error.message : String(error);
      setFileListError(message);
      setStatusMessage(`读取目录失败：${message}`);
    } finally {
      if (isCurrentRequest()) setIsLoadingFiles(false);
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

  // 空闲预热连接管理窗口与 chunk，降低菜单点击延迟
  useEffect(() => {
    preloadConnectionWindows();
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const visibleTerminalPaneIds = activeTab && (activeTab.kind === 'terminal' || activeTab.kind === 'rdp')
    ? collectTerminalLayoutTabIds(activeTab.layout ?? createDefaultTerminalLayout(activeTab.id))
    : [];
  const activePaneId = (activeTab?.kind === 'terminal' || activeTab?.kind === 'rdp')
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
  // 顶栏状态跟「当前焦点」：优先激活 pane；编辑器打开时显示文件名
  const statusFocusSession = useMemo(() => {
    if (showEditor) return null;
    return activePaneTab?.session ?? activeTab?.session ?? null;
  }, [showEditor, activePaneTab?.session, activeTab?.session]);
  const statusFocusEditor = useMemo(() => {
    if (!showEditor) return null;
    return editorTabs.find((tab) => tab.id === activeEditorTabId) ?? null;
  }, [showEditor, editorTabs, activeEditorTabId]);

  // pane 被移除（合并分屏、关闭终端）时，把归属它的文件标签改为无归属（渲染时回退到活动 pane）。
  // 按 workspace 分桶记忆已知 pane，避免切换 workspace 时误清其它 workspace 的归属。
  useEffect(() => {
    if (!activeTab || (activeTab.kind !== 'terminal' && activeTab.kind !== 'rdp')) return;
    const layout = activeTab.layout ?? createDefaultTerminalLayout(activeTab.id);
    const paneIds = collectTerminalLayoutTabIds(layout);
    const byWorkspace = knownPaneIdsByWorkspaceRef.current;
    const previous = byWorkspace.get(activeTab.id);
    const removed: string[] = [];
    if (previous) {
      for (const id of previous) {
        if (!paneIds.includes(id)) removed.push(id);
      }
    }
    byWorkspace.set(activeTab.id, new Set(paneIds));
    if (removed.length === 0) return;
    setEditorTabs((current) => current.map((t) =>
      t.hostPaneId && removed.includes(t.hostPaneId) ? { ...t, hostPaneId: null } : t,
    ));
  }, [activeTab?.id, activeTab?.layout]);

  /** 当前激活文件归属的 pane：编辑器区域显示在哪个 pane 由它决定（无归属回退活动 pane） */
  const editorDisplayPaneId = editorTabs.find((t) => t.id === activeEditorTabId)?.hostPaneId ?? activePaneId;
  const topStatusName = statusFocusEditor
    ? (statusFocusEditor.isUntitled
      ? statusFocusEditor.name
      : (statusFocusEditor.path || statusFocusEditor.name))
    : (statusFocusSession?.name ?? '');
  const topStatusUser = statusFocusEditor ? '' : (statusFocusSession?.username ?? '');
  const topStatusHost = statusFocusEditor ? '' : (statusFocusSession?.host ?? '');
  const activePaneTabRef = useRef<WorkspaceTab | null>(null);
  useEffect(() => {
    activePaneTabRef.current = activePaneTab;
  }, [activePaneTab]);

  const {
    monitorData,
    isLoadingMonitor,
    processList,
    isLoadingProcesses,
    processSortKey,
    processSortDir,
    toggleProcessSort,
    processSearch,
    setProcessSearch,
  } = useSystemMonitor({ leftActivity, activePaneTabRef, isLocalResourceTab });

  const {
    mediaViewer,
    isLoadingMedia,
    mediaError,
    openMediaViewer,
    closeMediaViewer,
    resetMediaViewer,
  } = useMediaViewer({ activePaneTabRef, isLocalResourceTab });

  // When the active pane changes (switching tabs, focusing a different split
  // pane, or after a remote connection establishes), reload the resource panel
  // so it reflects the newly focused terminal's filesystem.
  useEffect(() => {
    resetMediaViewer();
    if (!activePaneTab) return;
    // Remote panes become browseable only after the SSH terminal is ready.
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

  useEffect(() => {
    if (!openingConnection) return;

    const { tabId, startedAt } = openingConnection;
    let timedOut = false;

    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (openingSecondsRef.current) {
        openingSecondsRef.current.textContent = String(seconds);
      }
      if (seconds < 20 || timedOut) return;
      timedOut = true;
      const message = '连接超时：SSH 已启动但没有进入可用终端状态';
      setTabs((tabsCurrent) =>
        tabsCurrent.map((tab) => {
          if (tab.id !== tabId || tab.status !== 'connecting') {
            return tab;
          }
          cancelledConnectionTabIdsRef.current.add(tab.id);
          return {
            ...tab,
            status: 'failed',
            statusMessage: message,
            output: [...tab.output, `\r\n${message}\r\n`],
            activityLog: [...tab.activityLog, createActivity('error', message)].slice(-20),
          };
        }),
      );
      setStatusMessage(message);
      setOpeningConnection(null);
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [openingConnection?.tabId, openingConnection?.startedAt]);

  // Keep the active terminal focused without forcing a layout recalculation on every tab switch.
  useEffect(() => {
    if (activeTab?.kind !== 'terminal' || !activePaneId) return;
    focusTerminal(activePaneId);
    scheduleVisibleTerminalFits({ force: true });
  }, [activeTab?.id, activePaneId]);

  // 拖拽遮罩：拖出窗口 / 取消 / 失焦 / 切走资源面板时必须清掉
  useEffect(() => {
    if (leftActivity !== 'files') {
      clearResourceDragOverlay();
      return;
    }
    if (!isDragOver) return;

    const clear = () => clearResourceDragOverlay();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    const onDocDragLeave = (event: DragEvent) => {
      // 指针离开浏览器视口
      if (event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth
        || event.clientY >= window.innerHeight) {
        clear();
      }
    };

    window.addEventListener('dragend', clear, true);
    window.addEventListener('drop', clear, true);
    window.addEventListener('blur', clear);
    window.addEventListener('pointercancel', clear, true);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('dragleave', onDocDragLeave);

    return () => {
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('drop', clear, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('pointercancel', clear, true);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('dragleave', onDocDragLeave);
    };
  }, [isDragOver, leftActivity]);

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

  /** 关闭某 workspace 时一并关闭归属其 pane 的文件（未保存内容此时已被确认丢弃） */
  function closeEditorTabsForWorkspace(paneIds: Set<string>): void {
    if (paneIds.size === 0) return;
    const targetIds = editorTabsRef.current
      .filter((t) => t.hostPaneId && paneIds.has(t.hostPaneId))
      .map((t) => t.id);
    if (targetIds.length === 0) return;
    const targetSet = new Set(targetIds);
    setEditorTabs((current) => {
      const next = current.filter((t) => !targetSet.has(t.id));
      if (activeEditorTabId && targetSet.has(activeEditorTabId)) {
        const fallback = next.length > 0 ? next[next.length - 1].id : null;
        setActiveEditorTabId(fallback);
        if (!fallback) setShowEditor(false);
      }
      return next;
    });
    for (const id of targetIds) editorSaveGenerationRef.current.delete(id);
  }

  async function closeTab(tab: WorkspaceTab) {
    const currentTabs = tabsRef.current;
    const relatedTabIds = new Set<string>([tab.id]);
    const layout = tab.layout ?? createDefaultTerminalLayout(tab.id);
    const paneTabIds = (tab.kind === 'terminal' || tab.kind === 'rdp')
      ? collectTerminalLayoutTabIds(layout)
      : [];
    const replacementTab = currentTabs.find(
      (item) => item.id !== tab.id
        && paneTabIds.includes(item.id)
        && item.parentTabId === tab.id,
    );

    // workspace 根标签不能因为关闭自身而丢掉 pane 内通过双击创建的连接。
    // 提升第一个子标签为新的根，保留整个分屏布局和其它 pane 标签。
    if (replacementTab && (tab.kind === 'terminal' || tab.kind === 'rdp')) {
      const promotedLayout = tab.activePaneId === tab.id
        ? activateTerminalPaneTab(layout, replacementTab.id)
        : layout;
      const promotedTab = {
        ...replacementTab,
        layout: promotedLayout,
        activePaneId: tab.activePaneId && tab.activePaneId !== tab.id && paneTabIds.includes(tab.activePaneId)
          ? tab.activePaneId
          : replacementTab.id,
        parentTabId: undefined,
      };
      const nextTabs = currentTabs
        .filter((item) => item.id !== tab.id && item.id !== replacementTab.id)
        .map((item) => item.parentTabId === tab.id ? { ...item, parentTabId: promotedTab.id } : item);

      disposeTerminalRuntime({ ...tab, closedByUser: true, status: 'closed' });
      setTabs([...nextTabs, promotedTab]);
      setActiveTabId(promotedTab.id);
      setStatusMessage(`已切换到：${promotedTab.session.name}`);
      return;
    }

    const performWorkspaceClose = () => {
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of currentTabs) {
          if (item.parentTabId && relatedTabIds.has(item.parentTabId) && !relatedTabIds.has(item.id)) {
            relatedTabIds.add(item.id);
            expanded = true;
          }
        }
      }

      for (const relatedTab of currentTabs.filter((item) => relatedTabIds.has(item.id))) {
        if (relatedTab.kind === 'terminal' && relatedTab.status === 'connecting') {
          cancelledConnectionTabIdsRef.current.add(relatedTab.id);
        }
        disposeTerminalRuntime({ ...relatedTab, closedByUser: true, status: 'closed' });
      }

      const remainingTabs = currentTabs.filter((item) => !relatedTabIds.has(item.id));
      setTabs(remainingTabs);
      setActiveTabId((current) => {
        if (current && remainingTabs.some((item) => item.id === current)) return current;
        return remainingTabs.find((item) => !item.parentTabId)?.id ?? null;
      });

      // 该连接里打开的文件一并关闭，避免关闭后变成看不到的孤儿
      closeEditorTabsForWorkspace(new Set(paneTabIds));
    };

    // 该连接里有未保存的文件时先确认，防止误关丢失改动
    const dirtyFileCount = editorTabsRef.current.filter(
      (t) => t.hostPaneId && paneTabIds.includes(t.hostPaneId) && t.content !== t.originalContent,
    ).length;
    if (dirtyFileCount > 0) {
      requestConfirm({
        title: '连接含未保存文件',
        message: `该连接里有 ${dirtyFileCount} 个文件存在未保存的修改。关闭连接将同时关闭它们，未保存内容会丢失。确定关闭吗？`,
        confirmLabel: '关闭并丢弃更改',
        danger: true,
        onConfirm: performWorkspaceClose,
      });
      return;
    }
    performWorkspaceClose();
  }

  function focusTerminalPane(tabId: string) {
    const ownerTab = findTerminalWorkspaceOwner(tabsRef.current, tabId);
    if (!ownerTab) return;
    setShowEditor(false);
    setActiveTabId(ownerTab.id);
    setTabs((current) => current.map((item) => {
      if (item.id !== ownerTab.id) return item;
      const layout = activateTerminalPaneTab(item.layout ?? createDefaultTerminalLayout(item.id), tabId);
      return { ...item, layout, activePaneId: tabId };
    }));
    scheduleTerminalSettledFit(tabId);
    focusTerminal(tabId);
  }

  /** 编辑器视图下点击其它 pane：把焦点切到该终端，但保持编辑器停在宿主 pane（不关编辑器视图） */
  function focusPaneKeepEditor(tabId: string) {
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

  async function addTerminalTabToCurrentPane(session: Session) {
    // 本地终端固定在底部面板，不再进入工作区 pane
    if (session.id === localSession.id) {
      pendingPaneTabIdRef.current = null;
      setPendingPaneTabId(null);
      openLocalTerminalInBottomPanel();
      return;
    }

    const targetPaneId = pendingPaneTabIdRef.current ?? activePaneIdRef.current;
    const ownerTab = targetPaneId ? findTerminalWorkspaceOwner(tabsRef.current, targetPaneId) : null;
    if (!targetPaneId || !ownerTab) {
      pendingPaneTabIdRef.current = null;
      setPendingPaneTabId(null);
      await openRemoteTerminal(session);
      return;
    }

    const nextTab = createTerminalTab(
      session,
      '正在建立 SSH 连接...',
      ownerTab.id,
    );
    const nextLayout = addTerminalTabToPane(ownerTab.layout ?? createDefaultTerminalLayout(ownerTab.id), targetPaneId, nextTab.id);

    setPendingPaneTabId(null);
    setShowEditor(false);
    setTabs((current) => [
      ...current.map((item) => item.id === ownerTab.id ? { ...item, layout: nextLayout, activePaneId: nextTab.id } : item),
      nextTab,
    ]);
    setActiveTabId(ownerTab.id);
    setStatusMessage(`已添加到当前 pane：${session.name}`);
    revealPaneTab(nextTab.id);

    {
      const terminalId = crypto.randomUUID();
      terminalIdToTabIdRef.current.set(terminalId, nextTab.id);
      setTabs((current) => current.map((item) => item.id === nextTab.id
        ? { ...item, terminalId }
        : item));
      try {
        setOpeningConnection({ session, tabId: nextTab.id, startedAt: Date.now() });
        await connectSession(session.id, terminalId);
        if (cancelledConnectionTabIdsRef.current.delete(nextTab.id)) {
          retireTerminalId(terminalId);
          await disconnectSession(terminalId).catch(() => {});
          setOpeningConnection(null);
          return;
        }
        consumePendingTerminalOutput(terminalId, nextTab.id);
        consumePendingTerminalStatus(terminalId, nextTab.id);
        scheduleTerminalSettledFit(nextTab.id);
      } catch (error) {
        if (cancelledConnectionTabIdsRef.current.delete(nextTab.id)) {
          setOpeningConnection(null);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setOpeningConnection(null);
        applyTerminalStatusToTab({
          terminal_id: terminalId,
          transport: 'remote',
          state: 'failed',
          reason: message,
        }, nextTab.id);
      }
    }

    requestAnimationFrame(() => {
      scheduleTerminalSettledFit(nextTab.id);
      focusTerminal(nextTab.id);
    });
  }

  function addRdpTabToPane(session: Session, targetPaneId: string) {
    const ownerTab = findTerminalWorkspaceOwner(tabsRef.current, targetPaneId);
    if (!ownerTab) {
      openRdpTab(session);
      return;
    }

    const nextTab = createRdpTab(session, ownerTab.id);
    const nextLayout = addTerminalTabToPane(
      ownerTab.layout ?? createDefaultTerminalLayout(ownerTab.id),
      targetPaneId,
      nextTab.id,
    );

    setShowEditor(false);
    setTabs((current) => [
      ...current.map((item) => item.id === ownerTab.id
        ? { ...item, layout: nextLayout, activePaneId: nextTab.id }
        : item),
      nextTab,
    ]);
    setActiveTabId(ownerTab.id);
    setStatusMessage(`已新建远程桌面连接：${session.name}`);
    revealPaneTab(nextTab.id);
  }

  function revealPaneTab(tabId: string) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        paneTabElRefs.current.get(tabId)?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
      });
    });
  }

  function duplicatePaneConnection(tab: WorkspaceTab, targetPaneId: string) {
    if (tab.kind === 'rdp') {
      addRdpTabToPane(tab.session, targetPaneId);
      return;
    }

    pendingPaneTabIdRef.current = targetPaneId;
    setPendingPaneTabId(targetPaneId);
    void addTerminalTabToCurrentPane(tab.session);
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
    if (paneTab) {
      if (paneTab.status === 'connecting') {
        cancelledConnectionTabIdsRef.current.add(paneTab.id);
      }
      disposeTerminalRuntime({ ...paneTab, closedByUser: true, status: 'closed' });
    }

    setTabs((current) => current
      .filter((item) => item.id !== paneId)
      .map((item) => item.id === ownerTab.id ? { ...item, layout: nextLayout, activePaneId: nextActivePaneId } : item));
    setActiveTabId(ownerTab.id);
    setStatusMessage('已关闭当前终端 tab');
    scheduleTerminalSettledFit(nextActivePaneId);
    focusTerminal(nextActivePaneId);
  }

  async function openRemoteTerminal(session: Session) {
    if (session.id === localSession.id) {
      openLocalTerminalInBottomPanel();
      return;
    }

    const terminalId = crypto.randomUUID();
    const nextTab = { ...createTerminalTab(session, '正在建立 SSH 连接...'), terminalId };
    const tabId = nextTab.id;

    terminalIdToTabIdRef.current.set(terminalId, tabId);
    activeTabRef.current = nextTab;
    activeTabIdRef.current = tabId;
    setOpeningConnection({ session, tabId, startedAt: Date.now() });
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(tabId);
    setStatusMessage(`正在连接：${session.username}@${session.host}:${session.port}`);
    try {
      await connectSession(session.id, terminalId);
      if (cancelledConnectionTabIdsRef.current.delete(tabId)) {
        retireTerminalId(terminalId);
        await disconnectSession(terminalId).catch(() => {});
        setOpeningConnection(null);
        return;
      }
      consumePendingTerminalOutput(terminalId, tabId);
      consumePendingTerminalStatus(terminalId, tabId);
      scheduleTerminalSettledFit(tabId);
    } catch (error) {
      if (cancelledConnectionTabIdsRef.current.delete(tabId)) {
        setOpeningConnection(null);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setOpeningConnection(null);
      applyTerminalStatusToTab({
        terminal_id: terminalId,
        transport: 'remote',
        state: 'failed',
        reason: message,
      }, tabId);
    }
  }

  function getConnectionPanelTargetPaneId() {
    if (pendingPaneTabIdRef.current) return pendingPaneTabIdRef.current;
    if (activeTabRef.current?.kind === 'terminal' || activeTabRef.current?.kind === 'rdp') {
      return activePaneIdRef.current ?? activeTabRef.current.id;
    }
    return null;
  }

  async function openConnectionPanelSession(session: Session) {
    if (session.id === localSession.id) {
      openLocalTerminalInBottomPanel();
      return;
    }
    if (session.protocol === 'rdp') {
      openRdpTab(session);
      return;
    }

    const targetPaneId = getConnectionPanelTargetPaneId();
    if (targetPaneId) {
      await addTerminalTabToCurrentPane(session);
      return;
    }

    await openRemoteTerminal(session);
  }

  function openLocalTerminalInBottomPanel() {
    setOpenLocalTerminalKey((key) => key + 1);
    setStatusMessage('本地终端（底部面板）');
  }

  function openNewConnectionTab(paneId?: string) {
    const targetPaneId = paneId ?? activePaneIdRef.current;
    pendingPaneTabIdRef.current = targetPaneId;
    setPendingPaneTabId(targetPaneId);
    void openConnectionWindow('manage');
  }

  // Global terminal-output listener — registered once, routes by terminal_id
  useEffect(() => {
    let connUnlisten: (() => void) | null = null;
    let isActive = true;

    void listen<Session>('connection-window-connect-session', (event) => {
      if (!isActive) return;
      const session = event.payload;
      if (session.id === localSession.id) {
        openLocalTerminalInBottomPanel();
        return;
      }
      if (session.protocol === 'rdp') {
        openRdpTab(session);
        return;
      }
      if (pendingPaneTabIdRef.current) {
        void addTerminalTabToCurrentPane(session);
      } else {
        void openConnectionPanelSession(session);
      }
    }).then((unlisten) => {
      if (!isActive) {
        unlisten();
      } else {
        connUnlisten = unlisten;
      }
    });

    return () => {
      isActive = false;
      connUnlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let isActive = true;

    void listen<TerminalOutputEvent>('terminal-output', (event) => {
      if (!isActive) return;
      const terminalId = event.payload.terminal_id;
      if (retiredTerminalIdsRef.current.has(terminalId)) return;
      const payload = event.payload.payload;
      if (!payload) return;

      let targetTab = tabsRef.current.find((tab) => tab.terminalId === terminalId);
      if (!targetTab) {
        const fallbackTabId = terminalIdToTabIdRef.current.get(terminalId);
        if (fallbackTabId) targetTab = tabsRef.current.find((tab) => tab.id === fallbackTabId);
      }

      if (!targetTab) {
        const pending = pendingOutputRef.current.get(terminalId);
        if (pending) {
          pending.push(payload);
        } else {
          pendingOutputRef.current.set(terminalId, [payload]);
        }
        return;
      }

      setTabs((current) => current.map((item) => item.id === targetTab?.id
        ? {
            ...item,
            terminalId: item.terminalId || terminalId,
            output: [...item.output, payload].slice(-500),
          }
        : item));

      terminalsRef.current.get(targetTab.id)?.write(payload);
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

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let isActive = true;

    void listen<TerminalStatusEvent>('terminal-status', (event) => {
      if (!isActive) return;
      const status = event.payload;
      if (!shouldApplyTerminalStatus(status, retiredTerminalIdsRef.current)) return;

      let targetTab = tabsRef.current.find((tab) => tab.terminalId === status.terminal_id);
      if (!targetTab) {
        const fallbackTabId = terminalIdToTabIdRef.current.get(status.terminal_id);
        if (fallbackTabId) targetTab = tabsRef.current.find((tab) => tab.id === fallbackTabId);
      }

      if (!targetTab) {
        pendingTerminalStatusRef.current.set(status.terminal_id, status);
        return;
      }

      applyTerminalStatusToTab(status, targetTab.id);
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
        if (event.altKey) return true;

        const key = event.key.toLowerCase();
        const isCopyShortcut = event.ctrlKey
          && (event.code === 'KeyC' || key === 'c' || event.code === 'Insert');
        const isPasteShortcut = (event.ctrlKey && (event.code === 'KeyV' || key === 'v'))
          || (event.shiftKey && event.code === 'Insert');

        if (isCopyShortcut) {
          if (event.type !== 'keydown') return false;

          const selection = terminal.getSelection();
          if (selection) {
            event.preventDefault();
            event.stopPropagation();
            void copyTerminalSelection(tabId);
            return false;
          }

          // Plain Ctrl+C must still reach the PTY as SIGINT when nothing is selected.
          return event.code === 'KeyC' && !event.shiftKey;
        }

        if (isPasteShortcut) {
          event.preventDefault();
          event.stopPropagation();
          if (event.type === 'keydown' && !event.repeat) {
            void pasteToTerminal(tabId);
          }
          return false;
        }

        return true;
      });

      const dataDisposable = terminal.onData((data) => {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (!tab || !tab.terminalId) return;
        if (tab.session.id === localSession.id) {
          // 连接断开瞬间后端会返回 Err：吞掉即可，避免每次按键产生 unhandled rejection
          void sendLocalTerminalInput(tab.terminalId, data).catch(() => {});
        } else {
          void terminalWrite(tab.terminalId, data).catch(() => {});
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
            if (cancelledConnectionTabIdsRef.current.delete(terminalTab.id)) {
              retireTerminalId(profile.terminal_id);
              startedTerminalsRef.current.delete(terminalTab.id);
              terminalIdToTabIdRef.current.delete(profile.terminal_id);
              void stopLocalTerminal(profile.terminal_id).catch(() => {});
              return;
            }
            terminalIdToTabIdRef.current.set(profile.terminal_id, terminalTab.id);
            setTabs((current) =>
              current.map((item) =>
                item.id === terminalTab.id
                  ? { ...item, terminalId: profile.terminal_id }
                  : item,
              ),
            );
            consumePendingTerminalOutput(profile.terminal_id, terminalTab.id);
            consumePendingTerminalStatus(profile.terminal_id, terminalTab.id);
            startedTerminalsRef.current.add(profile.terminal_id);
            scheduleTerminalSettledFit(terminalTab.id);
          }).catch((error) => {
            if (cancelledConnectionTabIdsRef.current.delete(terminalTab.id)) {
              startedTerminalsRef.current.delete(terminalTab.id);
              return;
            }
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

  function createUntitledEditorTab() {
    const sequence = untitledEditorCounterRef.current++;
    const id = `untitled:${crypto.randomUUID()}`;
    const name = `Untitled-${sequence}`;
    const newTab: EditorTab = {
      id,
      path: '',
      name,
      language: 'plaintext',
      content: '',
      originalContent: '',
      isRemote: false,
      hostPaneId: activePaneIdRef.current,
      loading: false,
      error: '',
      isUntitled: true,
    };
    setEditorTabs((current) => [...current, newTab]);
    setActiveEditorTabId(id);
    setShowEditor(true);
    setStatusMessage(`已新建空白文件：${name}`);
  }

  function selectEditorWorkspaceTab(id: string) {
    setActiveEditorTabId(id);
    setShowEditor(true);
  }

  function selectSessionWorkspaceTab(tabId: string) {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (tab?.kind === 'terminal' || tab?.kind === 'rdp') {
      // workspace tab 是 root pane 的入口，不能只切 activeTabId；还要把 root 设为当前显示 pane。
      focusTerminalPane(tabId);
      return;
    }
    setActiveTabId(tabId);
    setShowEditor(false);
  }

  function editorTabLabel(tab: EditorTab, all: EditorTab[]): string {
    const sameName = all.filter((item) => item.name === tab.name).length;
    if (sameName <= 1) return tab.name;
    const parts = tab.path.split(/[/\\]/);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
    return parent ? `${tab.name} (${parent})` : tab.name;
  }

  /** 超过该大小的文件打开前先确认，避免误点大文件把界面卡死 */
  const HUGE_FILE_OPEN_BYTES = 20 * 1024 * 1024;

  async function openFileInEditor(file: ResourceFile, options?: { skipSizeConfirm?: boolean }) {
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

    // 超大文件先让用户确认，别一不留神把整个窗口卡住
    if (!options?.skipSizeConfirm && file.sizeBytes > HUGE_FILE_OPEN_BYTES) {
      requestConfirm({
        title: '文件较大',
        message: `「${file.name}」约 ${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB，打开会占用较多内存并可能明显卡顿。确定要打开吗？`,
        confirmLabel: '仍要打开',
        onConfirm: () => { void openFileInEditor(file, { skipSizeConfirm: true }); },
      });
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
      hostPaneId: activePaneIdRef.current,
      loading: true,
      error: '',
    };
    setEditorTabs((current) => [...current, newTab]);
    setActiveEditorTabId(tabId);
    setShowEditor(true);

    let transferId: string | null = null;
    let progressUnlisten: (() => void) | null = null;
    let openAbortController: AbortController | null = null;
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
      const activeTransferId = transferId;
      openAbortController = new AbortController();
      uploadAbortRefs.current.set(activeTransferId, openAbortController);
      try {
        progressUnlisten = await listen<{
          transfer_id: string;
          transferred: number;
          total: number;
        }>('file-open-progress', (event) => {
          if (event.payload.transfer_id !== activeTransferId || openAbortController?.signal.aborted) return;
          const transferred = Math.max(0, event.payload.transferred);
          const total = Math.max(0, event.payload.total || file.sizeBytes);
          const elapsed = (Date.now() - openStartTime) / 1000;
          const progress = total > 0 ? Math.min((transferred / total) * 100, 100) : 0;
          const speed = elapsed > 0 ? transferred / elapsed : 0;
          updateTransferRecord(activeTransferId, {
            progress,
            transferred,
            size: total,
            speed,
            message: total > 0 ? `正在读取... ${Math.round(progress)}%` : '正在读取...',
          });
          setEditorTabs((current) => current.map((item) => item.id === tabId
            ? { ...item, loadProgress: { transferred, total, speed } }
            : item));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addLogEntry('warn', `文件进度监听不可用：${message}`);
      }
    }

    try {
      const full = local
        ? await readLocalFileFull(file.path)
        : terminalId
          ? await readRemoteFileFull(terminalId, file.path, transferId)
          : null;
      if (openAbortController?.signal.aborted) {
        throw new DOMException('文件打开已取消', 'AbortError');
      }
      if (!full) {
        throw new Error('远程终端尚未连接，无法读取文件');
      }
      if (transferId) {
        const elapsed = (Date.now() - openStartTime) / 1000;
        const avgSpeed = elapsed > 0 ? full.size / elapsed : 0;
        updateTransferRecord(transferId, {
          status: 'success',
          progress: 100,
          transferred: full.size,
          size: full.size,
          speed: avgSpeed,
          message: '已打开',
        });
      }
      setEditorTabs((current) => current.map((t) =>
        t.id === tabId
          ? { ...t, content: full.content, originalContent: full.content, loading: false, loadProgress: undefined }
          : t,
      ));
      setStatusMessage(`已打开文件：${file.path}`);
    } catch (error) {
      const cancelled = openAbortController?.signal.aborted ?? false;
      const message = error instanceof Error ? error.message : String(error);
      if (transferId && !cancelled) {
        updateTransferRecord(transferId, { status: 'failed', message });
      }
      setEditorTabs((current) => current.map((t) =>
        t.id === tabId
          ? { ...t, loading: false, loadProgress: undefined, error: cancelled ? '文件打开已取消' : message }
          : t,
      ));
      setStatusMessage(cancelled ? `已取消打开：${file.name}` : `打开文件失败：${message}`);
    } finally {
      progressUnlisten?.();
      if (transferId) uploadAbortRefs.current.delete(transferId);
    }
  }

  function closeEditorTab(id: string) {
    editorSaveGenerationRef.current.delete(id);
    setEditorTabs((current) => {
      const next = current.filter((t) => t.id !== id);
      if (activeEditorTabId === id) {
        const fallback = next.length > 0 ? next[next.length - 1].id : null;
        setActiveEditorTabId(fallback);
        if (!fallback) setShowEditor(false);
      }
      return next;
    });
  }

  function updateEditorContent(id: string, content: string) {
    setEditorTabs((current) => {
      const target = current.find((t) => t.id === id);
      // 内容没变就原样返回：分屏时多个编辑器共享同一 model，
      // 一次输入会触发多次内容相同的回调，避免重复 re-render
      if (!target || target.content === content) return current;
      return current.map((t) => (t.id === id ? { ...t, content } : t));
    });
  }

  async function saveEditorFile(id: string) {
    // 上一次保存还没结束又触发：只做标记，避免两次写入并发、旧内容后落盘覆盖新内容
    if (editorSavingIdsRef.current.has(id)) {
      editorPendingSaveRef.current.add(id);
      return;
    }
    const tab = editorTabs.find((t) => t.id === id);
    if (!tab || tab.content === tab.originalContent) return;
    if (tab.isUntitled) {
      setStatusMessage('未命名文件需要先选择保存路径');
      return;
    }
    editorSavingIdsRef.current.add(id);
    const generation = (editorSaveGenerationRef.current.get(id) ?? 0) + 1;
    editorSaveGenerationRef.current.set(id, generation);
    setStatusMessage(`正在保存：${tab.path}`);
    try {
      if (tab.isRemote && tab.terminalId) {
        await writeRemoteFile(tab.terminalId, tab.path, tab.content);
      } else {
        await writeLocalFile(tab.path, tab.content);
      }
      if (editorSaveGenerationRef.current.get(id) !== generation) return;
      setEditorTabs((current) => current.map((t) =>
        t.id === id ? { ...t, originalContent: tab.content } : t,
      ));
      setStatusMessage(`已保存：${tab.path}`);
    } catch (error) {
      if (editorSaveGenerationRef.current.get(id) !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`保存失败：${message}`);
    } finally {
      editorSavingIdsRef.current.delete(id);
      // 保存期间又有新改动：再存一次，保证最终落盘的是最新内容
      if (editorPendingSaveRef.current.delete(id)) {
        void saveEditorFile(id);
      }
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
    const sourcePaneKey = tab?.id ?? '__local__';
    const local = isLocalResourceTab(tab);
    const destDir = currentPath || (local ? '.' : '~');
    const targetLabel = local ? '本地' : `远程 ${tab?.session.name ?? ''}`;
    const terminalId = local ? null : tab?.terminalId ?? null;
    setIsUploading(true);
    let uploaded = 0;
    let skipped = 0;
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

    // 提升到函数级作用域，保证 finally 里能统一清理（进度监听与中止表）
    let progressUnlisten: (() => void) | null = null;
    let recordIds: string[] = [];

    try {
      const fileItems = fileList.map((file, i) => ({
        file,
        localPath: localPaths?.[i],
        relPath: relativePaths?.[i],
      }));
      const visibleTargetNames = new Set(resourceFiles.map((file) => file.name));
      const plannedRootNames = new Set(visibleTargetNames);
      const hasVisibleConflict = !local && fileItems.some(({ file, relPath }) => {
        if (relPath) {
          const { parent, name } = splitUploadRelativePath(relPath);
          return parent === '' && visibleTargetNames.has(name || file.name);
        }
        return visibleTargetNames.has(file.name);
      });

      // One shared progress listener for all concurrent uploads. It maps each
      // event's transfer_id back to its transfer record and updates progress.
      const speedTrackers = new Map<string, { startTime: number }>();
      progressUnlisten = await listen<{
        transfer_id: string;
        phase: 'transferring' | 'verifying' | 'committing';
        transferred?: number;
        total?: number;
      }>(
        'upload-progress',
        (event) => {
          const { transfer_id, phase } = event.payload;
          if (phase === 'verifying' || phase === 'committing') {
            updateTransferRecord(transfer_id, (prev) => ({
              progress: 100,
              transferred: prev.size,
              speed: 0,
              message: phase === 'verifying'
                ? '数据已发送，等待远程确认...'
                : '远程确认完成，正在提交文件...',
            }));
            return;
          }

          const transferred = event.payload.transferred ?? 0;
          const total = event.payload.total ?? 0;
          const tracker = speedTrackers.get(transfer_id);
          const elapsed = tracker ? (Date.now() - tracker.startTime) / 1000 : 0;
          const measuredSpeed = elapsed > 0 ? transferred / elapsed : 0;
          updateTransferRecord(transfer_id, (prev) => {
            const progress = total > 0 ? Math.min((transferred / total) * 100, 100) : 0;
            const sizePatch = prev.size === 0 && total > 0 ? { size: total } : {};
            return { progress, transferred, speed: measuredSpeed, message: '正在传输...', ...sizePatch };
          });
        },
      );

      const uploadOne = async (job: {
        file: File;
        localPath?: string;
        relPath?: string;
        fileDestDir: string;
        targetFileName: string;
        displayFileName: string;
        recordId: string;
      }) => {
        const { file, localPath, recordId } = job;
        let { fileDestDir, targetFileName, displayFileName } = job;
        const abortCtrl = uploadAbortRefs.current.get(recordId);
        if (!abortCtrl || abortCtrl.signal.aborted) {
          // 排队阶段已取消：记录已由 cancelUpload 标记
          return;
        }

        const isRootTarget = !job.relPath || splitUploadRelativePath(job.relPath).parent === '';
        if (!local && isRootTarget) {
          const existingTarget = resourceFiles.find((entry) => entry.name === targetFileName);
          if (existingTarget) {
            const decision = await requestUploadConflictDecision(file, existingTarget, plannedRootNames);
            if (abortCtrl.signal.aborted) return;
            if (!decision || decision.action === 'skip') {
              skipped += 1;
              uploadAbortRefs.current.delete(recordId);
              updateTransferRecord(recordId, { status: 'cancelled', message: '已跳过' });
              addLogEntry('info', `已跳过上传：${displayFileName}`);
              return;
            }
            if (decision.action === 'rename') {
              const nextName = decision.newName?.trim() ?? '';
              if (!nextName || nextName === '.' || nextName === '..' || nextName.includes('/') || nextName.includes('\\')) {
                failed += `${displayFileName}: 无效的新文件名; `;
                uploadAbortRefs.current.delete(recordId);
                updateTransferRecord(recordId, { status: 'failed', message: '无效的新文件名' });
                addLogEntry('error', `上传失败：${displayFileName} - 无效的新文件名`);
                return;
              }
              targetFileName = nextName;
              displayFileName = job.relPath ? targetFileName : nextName;
              updateTransferRecord(recordId, { fileName: displayFileName });
            }
          }
          plannedRootNames.add(targetFileName);
        }

        // 远程上传且有本地路径时，走流式上传，避免前端 base64 编码阻塞 UI。
        const useStreamUpload = !local && terminalId && localPath;
        const startTime = Date.now();
        speedTrackers.set(recordId, { startTime });
        // 真正开传：等待 → 上传中；startTime 从现在算，排队不计入耗时
        updateTransferRecord(recordId, {
          status: 'uploading',
          message: '上传中...',
          startTime,
          endTime: null,
        });
        try {
          if (abortCtrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
          if (useStreamUpload) {
            // 流式上传：Rust 端直接读取本地文件分块上传，前端不接触文件内容。
            await uploadLocalFile(localPath!, fileDestDir || destDir, recordId, terminalId!, targetFileName);
          } else {
            // 降级路径：前端读取文件内容并 base64 编码后上传。
            const buffer = await file.arrayBuffer();
            if (abortCtrl.signal.aborted) throw new DOMException('已取消', 'AbortError');
            await uploadFile(targetFileName, new Uint8Array(buffer), fileDestDir || destDir, recordId, terminalId);
          }
          uploadAbortRefs.current.delete(recordId);
          uploaded += 1;
          const elapsed = (Date.now() - startTime) / 1000;
          const avgSpeed = elapsed > 0 ? file.size / elapsed : 0;
          updateTransferRecord(recordId, { status: 'success', progress: 100, transferred: file.size, speed: avgSpeed, message: '已完成' });
          addLogEntry('info', `上传成功：${displayFileName} → ${fileDestDir || destDir} (${formatFileSize(file.size)})`);
        } catch (error) {
          uploadAbortRefs.current.delete(recordId);
          if (abortCtrl.signal.aborted) {
            updateTransferRecord(recordId, { status: 'cancelled', message: '已取消' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          failed += `${displayFileName}: ${message}; `;
          updateTransferRecord(recordId, { status: 'failed', message });
          addLogEntry('error', `上传失败：${displayFileName} - ${message}`);
        }
      };

      // 全部先入队为「等待」，再由并发池开传；列表能看到尚未轮到的文件
      type UploadJob = {
        file: File;
        localPath?: string;
        relPath?: string;
        fileDestDir: string;
        targetFileName: string;
        displayFileName: string;
        recordId: string;
      };
      const preparedJobs: Omit<UploadJob, 'recordId'>[] = fileItems.map(({ file, localPath, relPath }) => {
        let fileDestDir = destDir;
        let targetFileName = file.name;
        if (relPath) {
          const { parent, name } = splitUploadRelativePath(relPath);
          targetFileName = name || file.name;
          if (parent) {
            fileDestDir = joinRemotePath(destDir, parent);
          }
        }
        return {
          file,
          localPath,
          relPath,
          fileDestDir,
          targetFileName,
          displayFileName: relPath || file.name,
        };
      });
      recordIds = addTransferRecords(
        preparedJobs.map((job) => ({
          fileName: job.displayFileName,
          direction: 'upload' as const,
          target: job.fileDestDir || destDir,
          size: job.file.size,
          status: 'pending' as const,
          message: '等待上传...',
        })),
      );
      const jobs: UploadJob[] = preparedJobs.map((job, index) => {
        const recordId = recordIds[index];
        uploadAbortRefs.current.set(recordId, new AbortController());
        return { ...job, recordId };
      });

      // Bounded concurrency pool — upload several files in parallel so the
      // per-file SSH round-trip latency is overlapped (like XShell's SFTP).
      // Pick the pool size from local CPU load: busy => 1, idle => 2.
      let CONCURRENCY = 2;
      if (hasVisibleConflict) {
        CONCURRENCY = 1;
      } else {
        try {
          const recommended = await getUploadConcurrency();
          if (typeof recommended === 'number' && recommended >= 1) {
            CONCURRENCY = Math.min(Math.max(Math.trunc(recommended), 1), 2);
          }
        } catch {
          // Keep default of 2 if the command is unavailable.
        }
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const idx = cursor++;
          if (idx >= jobs.length) break;
          await uploadOne(jobs[idx]);
        }
      };
      const poolSize = Math.min(CONCURRENCY, jobs.length);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < poolSize; w++) workers.push(worker());
      await Promise.all(workers);

      if (uploaded > 0) {
        setStatusMessage(`已上传 ${uploaded} 个文件到 ${targetLabel}：${destDir}${skipped > 0 ? `，跳过 ${skipped} 个` : ''}`);
        if ((activePaneTabRef.current?.id ?? '__local__') === sourcePaneKey && currentPathRef.current === destDir) {
          await loadResourceDirectory(destDir, false);
        }
      } else if (skipped > 0) {
        setStatusMessage(`已跳过 ${skipped} 个文件`);
      }
      if (failed) {
        setStatusMessage(`部分文件上传失败：${failed}`);
      }
    } finally {
      // 无论正常结束、并发池抛错还是被取消，都清理本批上传的进度监听与中止表，避免泄漏
      progressUnlisten?.();
      for (const rid of recordIds) uploadAbortRefs.current.delete(rid);
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
      const rootName = relParts[0];
      // Remove the last part (filename) from relParts to get the relative directory path
      const relDirDepth = relParts.length - 1; // number of directory levels below root
      // Remove relDirDepth parts from the end of the local path, plus the filename
      const localParts = localPaths[0].split(/[/\\]/);
      const rootDir = localParts.slice(0, localParts.length - relDirDepth - 1).join('/');
      if (rootDir && !resourceFiles.some((entry) => entry.name === rootName)) {
        await handleDirectoryUpload(rootDir, tab.terminalId);
        if (folderInputRef.current) folderInputRef.current.value = '';
        return;
      }
    }

    // Fallback: upload files individually with relative paths
    await uploadFiles(fileArray, localPaths.length > 0 && localPaths.every(p => p) ? localPaths : undefined, relativePaths);
    if (folderInputRef.current) folderInputRef.current.value = '';
  }

  function clearResourceDragOverlay() {
    resourceDragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleDragOver(event: React.DragEvent) {
    if (leftActivity !== 'files' || isUploading) return;
    // Must preventDefault on dragover to allow drop and clear the forbidden cursor.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  }

  function handleDragEnter(event: React.DragEvent) {
    if (leftActivity !== 'files' || isUploading) return;
    event.preventDefault();
    resourceDragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    if (leftActivity !== 'files') return;
    // 进入子节点时 relatedTarget 仍在面板内，不清理
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    resourceDragDepthRef.current = Math.max(0, resourceDragDepthRef.current - 1);
    if (resourceDragDepthRef.current === 0) setIsDragOver(false);
  }

  async function handleNativeResourceDrop(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (uniquePaths.length === 0) return;

    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const destination = currentPathRef.current;
    if (local) {
      if (!destination) {
        setStatusMessage('请先打开本地目标目录');
        return;
      }
      for (const source of uniquePaths) {
        try {
          await copyPath(source, destination);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addLogEntry('error', `复制失败：${source} - ${message}`);
        }
      }
      await loadResourceDirectory(destination, false);
      return;
    }

    if (!tab?.terminalId) {
      setStatusMessage('请先连接远程终端');
      return;
    }

    const directories: string[] = [];
    const files: string[] = [];
    for (const path of uniquePaths) {
      try {
        await listLocalDirectory(path);
        directories.push(path);
      } catch {
        files.push(path);
      }
    }

    for (const directory of directories) {
      await handleDirectoryUpload(directory, tab.terminalId);
    }
    if (files.length > 0) {
      const placeholders = files.map((path) => {
        const name = path.split(/[/\\]/).filter(Boolean).pop() || 'file';
        return new globalThis.File([], name);
      });
      await uploadFiles(placeholders, files);
    }
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    clearResourceDragOverlay();

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
                const rootName = relParts[0];
                const relDepth = relParts.length - 1; // directory levels below root
                const localParts = firstLocalPath.split(/[/\\]/);
                const rootDir = localParts.slice(0, localParts.length - relDepth - 1).join('/');
                if (rootDir && !resourceFiles.some((entry) => entry.name === rootName)) {
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
    const sourcePaneKey = activePaneTabRef.current?.id ?? '__local__';
    const destDir = currentPath || '~';
    const dirName = localPath.split(/[/\\]/).pop() || '';
    setIsUploading(true);
    addLogEntry('info', `开始上传目录 ${dirName} 到远程：${destDir}`);
    setStatusMessage(`正在上传目录 ${dirName}...`);
    const recordId = addTransferRecord({
      fileName: dirName,
      direction: 'upload',
      target: destDir,
      size: 0,
      status: 'uploading',
      message: '目录上传中...',
    });
    const abortCtrl = new AbortController();
    uploadAbortRefs.current.set(recordId, abortCtrl);
    const uploadStartedAt = Date.now();
    let progressUnlisten: (() => void) | null = null;

    try {
      progressUnlisten = await listen<{
        transfer_id: string;
        phase: 'transferring' | 'verifying' | 'committing';
        transferred?: number;
        total?: number;
      }>('upload-progress', (event) => {
        if (event.payload.transfer_id !== recordId || event.payload.phase !== 'transferring') return;
        const transferred = event.payload.transferred ?? 0;
        const total = event.payload.total ?? 0;
        const elapsed = (Date.now() - uploadStartedAt) / 1000;
        updateTransferRecord(recordId, {
          progress: total > 0 ? Math.min((transferred / total) * 100, 100) : 0,
          transferred,
          size: total,
          speed: elapsed > 0 ? transferred / elapsed : 0,
          message: '目录上传中...',
        });
      });
      const result = await uploadDirectory(localPath, destDir, terminalId, recordId);
      const msg = result.failed_items.length > 0
        ? `目录上传完成：${result.files_uploaded} 个文件，${result.dirs_created} 个目录${result.failed_items.length > 0 ? `，${result.failed_items.length} 个失败` : ''}`
        : `目录上传完成：${result.files_uploaded} 个文件，${result.dirs_created} 个目录`;
      updateTransferRecord(recordId, {
        status: result.failed_items.length > 0 ? 'failed' : 'success',
        progress: 100,
        transferred: result.total_bytes,
        size: result.total_bytes,
        message: result.failed_items.length > 0 ? '部分失败' : '已完成',
      });
      addLogEntry(result.failed_items.length > 0 ? 'warn' : 'info', msg);
      if (result.failed_items.length > 0) {
        addLogEntry('error', `失败项：${result.failed_items.join('; ')}`);
      }
      setStatusMessage(msg);
      if ((activePaneTabRef.current?.id ?? '__local__') === sourcePaneKey) {
        await loadResourceDirectory(destDir, false);
      }
    } catch (error) {
      if (abortCtrl.signal.aborted) {
        updateTransferRecord(recordId, { status: 'cancelled', message: '已取消' });
        setStatusMessage(`目录上传已取消：${dirName}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateTransferRecord(recordId, { status: 'failed', message });
      addLogEntry('error', `目录上传失败：${message}`);
      setStatusMessage(`目录上传失败：${message}`);
    } finally {
      progressUnlisten?.();
      uploadAbortRefs.current.delete(recordId);
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
    addLogEntry('info', `开始下载：${file.name} → 系统下载目录`);
    const recordId = addTransferRecord({
      fileName: file.name,
      direction: 'download',
      target: '系统下载目录',
      size: file.sizeBytes,
      status: 'uploading',
      message: '正在接收数据...',
    });
    const abortCtrl = new AbortController();
    uploadAbortRefs.current.set(recordId, abortCtrl);
    const startTime = Date.now();
    try {
      const savedPath = await downloadRemoteFile(tab.terminalId, file.path, recordId);
      const elapsed = (Date.now() - startTime) / 1000;
      const avgSpeed = elapsed > 0 ? file.sizeBytes / elapsed : 0;
      updateTransferRecord(recordId, { status: 'success', progress: 100, transferred: file.sizeBytes, speed: avgSpeed, message: '已完成', target: savedPath });
      addLogEntry('info', `下载完成：${file.name} → ${savedPath} (${formatFileSize(file.sizeBytes)})`);
      setStatusMessage(`已下载到：${savedPath}`);
    } catch (error) {
      if (abortCtrl.signal.aborted) {
        updateTransferRecord(recordId, { status: 'cancelled', message: '已取消' });
        setStatusMessage(`下载已取消：${file.name}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateTransferRecord(recordId, { status: 'failed', message });
      addLogEntry('error', `下载失败：${file.name} - ${message}`);
      setStatusMessage(`下载失败：${message}`);
    } finally {
      uploadAbortRefs.current.delete(recordId);
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
  function clearPendingInlineRename() {
    if (pendingInlineRenameTimerRef.current !== null) {
      window.clearTimeout(pendingInlineRenameTimerRef.current);
      pendingInlineRenameTimerRef.current = null;
    }
  }

  function handleFileClick(event: React.MouseEvent, file: ResourceFile, index: number) {
    (event.currentTarget as HTMLElement).focus();
    const ctrl = event.ctrlKey || event.metaKey; // metaKey for macOS
    const shift = event.shiftKey;
    const plainClick = !ctrl && !shift;
    const clickedName = Boolean((event.target as HTMLElement).closest('.file-name'));
    const wasOnlySelected = selectedFiles.size === 1 && selectedFiles.has(file.name);
    const now = Date.now();
    const previousClick = lastPlainFileClickRef.current;

    clearPendingInlineRename();
    if (
      plainClick
      && clickedName
      && !inlineRename
      && wasOnlySelected
      && previousClick?.path === file.path
      && now - previousClick.at >= RESOURCE_RENAME_SECOND_CLICK_DELAY_MS
    ) {
      pendingInlineRenameTimerRef.current = window.setTimeout(() => {
        pendingInlineRenameTimerRef.current = null;
        beginInlineRename(file);
      }, 260);
    }

    lastPlainFileClickRef.current = plainClick ? { path: file.path, at: now } : null;

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

  function handleFileDoubleClick(file: ResourceFile) {
    clearPendingInlineRename();
    lastPlainFileClickRef.current = null;
    if (inlineRename?.path === file.path) setInlineRename(null);
    void openSelectedFile(file);
  }

  function getSelectedResourceFiles(): ResourceFile[] {
    return visibleFiles.filter((f) => selectedFiles.has(f.name));
  }

  function handleSelectAll() {
    setSelectedFiles(new Set(visibleFiles.map((f) => f.name)));
  }

  function handleResourceKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, button, select, [contenteditable="true"]')) return;

    const ctrl = event.ctrlKey || event.metaKey;
    const selectedItems = getSelectedResourceFiles();

    if (event.key === 'F2' && selectedItems.length === 1) {
      event.preventDefault();
      beginInlineRename(selectedItems[0]);
      return;
    }

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
    clearPendingInlineRename();
    lastPlainFileClickRef.current = null;
    setInlineRename(null);
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
    clearPendingInlineRename();
    lastPlainFileClickRef.current = null;
    setInlineRename(null);
    setContextMenu({ x: event.clientX, y: event.clientY, file: null });
  }

  function handleTerminalContextMenu(event: React.MouseEvent, tabId: string) {
    event.preventDefault();
    event.stopPropagation();

    const term = terminalsRef.current.get(tabId);
    const selection = term?.getSelection() ?? '';

    if (event.shiftKey) {
      setTerminalContextMenu({ x: event.clientX, y: event.clientY, tabId, selection });
      return;
    }

    if (selection) {
      void copyTerminalSelection(tabId);
      return;
    }

    term?.focus();
    void pasteToTerminal(tabId);
  }

  async function copyTerminalSelection(tabId: string) {
    const term = terminalsRef.current.get(tabId);
    const selection = term?.getSelection();
    setTerminalContextMenu(null);
    if (!term || !selection) return;

    try {
      await writeClipboardText(selection);
      if (terminalsRef.current.get(tabId) === term) {
        term.clearSelection();
      }
      setStatusMessage(`已复制 ${selection.length} 个字符`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`复制失败：${message}`);
    }
  }

  function commitTerminalPaste(tabId: string, prepared: PreparedTerminalPaste) {
    const term = terminalsRef.current.get(tabId);
    if (!term) {
      setStatusMessage('粘贴失败：终端已关闭');
      return;
    }

    term.focus();
    term.paste(prepared.text);
    setStatusMessage(prepared.truncated
      ? `已粘贴前 ${formatTerminalPasteSize(prepared.pasteBytes)}，超出部分已截断`
      : `已粘贴 ${prepared.lineCount} 行（${formatTerminalPasteSize(prepared.pasteBytes)}）`);
  }

  async function pasteToTerminal(tabId: string) {
    const term = terminalsRef.current.get(tabId);
    setTerminalContextMenu(null);
    if (!term || terminalPasteInFlightRef.current.has(tabId)) return;

    terminalPasteInFlightRef.current.add(tabId);
    try {
      const text = await readClipboardText();
      if (terminalsRef.current.get(tabId) !== term) {
        setStatusMessage('粘贴已取消：目标终端已关闭或重新创建');
        return;
      }
      if (!text) {
        setStatusMessage('剪贴板中没有可粘贴的文本');
        return;
      }

      const prepared = prepareTerminalPaste(text);
      if (prepared.requiresConfirmation) {
        setPendingTerminalPaste({ tabId, ...prepared });
        return;
      }

      commitTerminalPaste(tabId, prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`读取剪贴板失败：${message}`);
    } finally {
      terminalPasteInFlightRef.current.delete(tabId);
    }
  }

  function handleTerminalPasteEvent(event: React.ClipboardEvent, tabId: string) {
    event.preventDefault();
    event.stopPropagation();
    void pasteToTerminal(tabId);
  }

  function searchTerminalSelection(selection: string) {
    const query = selection.trim();
    if (query) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    setTerminalContextMenu(null);
  }

  function clearTerminalScreen(tabId: string) {
    const term = terminalsRef.current.get(tabId);
    term?.clear();
    setTerminalContextMenu(null);
  }

  function requestConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  }) {
    setConfirmDialog({ confirmLabel: '确定', ...opts });
  }

  async function executeDeletePaths(files: ResourceFile[]) {
    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const count = files.length;
    const label = count === 1 ? files[0].name : `${count} 个项目`;
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

  async function handleDeletePaths(files: ResourceFile[]) {
    const count = files.length;
    const label = count === 1 ? files[0].name : `${count} 个项目`;
    requestConfirm({
      title: '删除确认',
      message: `确定删除「${label}」吗？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => executeDeletePaths(files),
    });
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

  function resourceBaseName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() ?? trimmed;
  }

  function resourceParentPath(path: string, local: boolean): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    const lastSeparator = local
      ? Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      : trimmed.lastIndexOf('/');
    if (lastSeparator < 0) return local ? '.' : '~';
    return trimmed.substring(0, lastSeparator) || (local ? '.' : '/');
  }

  function joinResourcePath(directory: string, name: string, local: boolean): string {
    if (!directory || directory === '.') return name;
    const separator = local && directory.includes('\\') ? '\\' : '/';
    return directory.endsWith('/') || directory.endsWith('\\')
      ? `${directory}${name}`
      : `${directory}${separator}${name}`;
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
    const targetTerminalId = local ? null : tab?.terminalId ?? null;
    if (!local && !targetTerminalId) {
      setStatusMessage('粘贴失败：目标远程会话尚未连接');
      return;
    }
    if (clipboard.terminalId !== targetTerminalId) {
      setStatusMessage('暂不支持跨本地与远程会话直接粘贴');
      return;
    }
    const destDir = currentPathRef.current || (local ? '.' : '~');
    // Build a set of existing file names in the destination directory.
    const existingNames = new Set(resourceFilesRef.current.map((f) => f.name));
    setStatusMessage(`正在粘贴 ${clipboard.paths.length} 个项目...`);
    try {
      for (const srcPath of clipboard.paths) {
        const srcName = resourceBaseName(srcPath);
        // When cutting within the same directory (source parent == destDir),
        // this is a no-op — skip it.
        const srcParent = resourceParentPath(srcPath, local);
        if (clipboard.operation === 'cut' && srcParent === destDir) {
          addLogEntry('info', `剪切跳过：${srcName} 已在目标目录中`);
          continue;
        }
        const destName = generateUniqueName(srcName, existingNames);
        if (clipboard.operation === 'copy') {
          await copyPath(srcPath, destDir, targetTerminalId, destName === srcName ? undefined : destName);
          addLogEntry('info', `已复制：${srcPath} → ${joinResourcePath(destDir, destName, local)}`);
        } else {
          await movePath(srcPath, destDir, targetTerminalId, destName === srcName ? undefined : destName);
          addLogEntry('info', `已移动：${srcPath} → ${joinResourcePath(destDir, destName, local)}`);
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
    const fullPath = joinResourcePath(baseDir, newItemName.trim(), local);
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
    clearPendingInlineRename();
    setInlineRename(null);
    lastPlainFileClickRef.current = null;
    setRenameValue(file.name);
    setRenameDialog(file.path);
  }

  async function renameResource(path: string, requestedName: string): Promise<boolean> {
    const newName = requestedName.trim();
    const currentName = resourceBaseName(path);
    if (!newName || newName === '.' || newName === '..' || newName.includes('/') || newName.includes('\\')) {
      setStatusMessage('重命名失败：文件名无效');
      return false;
    }
    if (newName === currentName) return true;

    const tab = activePaneTabRef.current;
    const local = isLocalResourceTab(tab);
    const parent = currentPathRef.current || resourceParentPath(path, local);
    setStatusMessage(`正在重命名：${newName}...`);
    try {
      await movePath(path, parent, local ? null : tab?.terminalId ?? null, newName);
      setStatusMessage(`已重命名为：${newName}`);
      addLogEntry('info', `已重命名：${currentName} → ${newName}`);
      await loadResourceDirectory(currentPathRef.current || null, false);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`重命名失败：${message}`);
      addLogEntry('error', `重命名失败：${message}`);
      return false;
    }
  }

  async function handleRename() {
    if (!renameDialog) return;
    if (await renameResource(renameDialog, renameValue)) {
      setRenameDialog(null);
    }
  }

  function beginInlineRename(file: ResourceFile) {
    clearPendingInlineRename();
    setRenameDialog(null);
    setInlineRename({
      path: file.path,
      originalName: file.name,
      value: file.name,
      type: file.type,
      submitting: false,
    });
  }

  function cancelInlineRename() {
    clearPendingInlineRename();
    setInlineRename(null);
    lastPlainFileClickRef.current = null;
  }

  async function submitInlineRename() {
    if (!inlineRename || inlineRename.submitting) return;
    const nextName = inlineRename.value.trim();
    if (nextName === inlineRename.originalName) {
      cancelInlineRename();
      return;
    }
    setInlineRename((current) => current ? { ...current, submitting: true } : null);
    const renamed = await renameResource(inlineRename.path, nextName);
    if (renamed) {
      setInlineRename(null);
    } else {
      setInlineRename((current) => current ? { ...current, submitting: false } : null);
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

  // Close the terminal right-click menu on any outside click / new right-click
  useEffect(() => {
    if (!terminalContextMenu) return;
    const close = () => setTerminalContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('blur', close);
    };
  }, [terminalContextMenu]);

  // 刚进入 AI 面板：随后的定位要瞬时到底
  useEffect(() => {
    if (leftActivity === 'ai') {
      aiInstantScrollRef.current = true;
    }
  }, [leftActivity]);

  useEffect(() => {
    if (leftActivity !== 'ai') return;
    if (aiInstantScrollRef.current) {
      aiInstantScrollRef.current = false;
      const messageList = aiMessageListRef.current;
      // 打开面板 / 切换会话 / 载入历史：直接定位到底部，不做滚动动画
      if (messageList) {
        messageList.scrollTop = messageList.scrollHeight;
        return;
      }
    }
    aiMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [aiMessages, isAiGenerating, leftActivity]);

  useEffect(() => {
    if (leftActivity === 'ai' && !aiProviderConfig && !isAiConfigLoading && !aiConfigError) {
      void refreshAiProviderConfig();
    }
  }, [leftActivity, aiProviderConfig, isAiConfigLoading, aiConfigError]);

  useEffect(() => {
    if (isAiSettingsWindow) return;
    // disposed 守卫：避免 cleanup 先于 listen() resolve 时（StrictMode 双挂载/HMR）
    // 产生无清理的常驻监听
    let disposed = false;
    let removeListener: (() => void) | null = null;
    void listen('ai-provider-config-changed', () => {
      if (disposed) return;
      void refreshAiProviderConfig();
    }).then((remove) => {
      if (disposed) { remove(); return; }
      removeListener = remove;
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void listAiConversations()
      .then((conversations) => {
        if (disposed) return;
        if (conversations.length > 0) {
          const restored = conversations.map(fromStoredAiConversation);
          setAiWorkspace({ conversations: restored, activeConversationId: restored[0].id });
        }
        aiConversationsLoadedRef.current = true;
      })
      .catch((error) => {
        if (!disposed) setAiConversationError(error instanceof Error ? error.message : String(error));
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!aiConversationsLoadedRef.current || !activeAiConversation) return;
    const timeoutId = window.setTimeout(() => {
      void saveAiConversation(toStoredAiConversation(activeAiConversation))
        .catch((error) => setAiConversationError(error instanceof Error ? error.message : String(error)));
    }, 600);
    return () => window.clearTimeout(timeoutId);
  }, [activeAiConversation]);

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | null = null;
    void listen<AiChatStreamEvent>('ai-chat-stream', ({ payload }) => {
      if (disposed) return;
      const activeRequest = aiActiveRequestRef.current;
      if (!activeRequest || payload.request_id !== activeRequest.requestId) return;
      if (payload.kind === 'delta' && payload.delta) {
        activeRequest.content += payload.delta;
        updateAiConversation(activeRequest.conversationId, (conversation) => ({
          ...conversation,
          updatedAt: new Date().toISOString(),
          messages: conversation.messages.map((message) => message.id === activeRequest.assistantMessageId
            ? { ...message, content: message.content + payload.delta }
            : message),
        }));
        return;
      }
      if (payload.kind === 'completed') {
        if (payload.tool_calls && payload.tool_calls.length > 0) {
          activeRequest.toolCalls = payload.tool_calls.map((item) => ({
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          }));
        }
        finishAiStreamRef.current(activeRequest, 'complete');
      } else if (payload.kind === 'cancelled') {
        finishAiStreamRef.current(activeRequest, 'cancelled');
      } else if (payload.kind === 'error') {
        finishAiStreamRef.current(activeRequest, 'error', payload.message ?? 'AI 请求失败');
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else removeListener = unlisten;
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  function updateAiConversation(
    conversationId: string,
    updater: (conversation: AiConversationState) => AiConversationState,
  ) {
    setAiWorkspace((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => conversation.id === conversationId
        ? updater(conversation)
        : conversation),
    }));
  }

  function finishAiStream(
    activeRequest: NonNullable<typeof aiActiveRequestRef.current>,
    status: 'complete' | 'cancelled' | 'error',
    errorMessage?: string,
  ) {
    let shouldRepairAgentProtocol = false;
    /** 用对象承载，避免 TS 认为 setState updater 不会同步执行导致 never */
    const autoRunCapture: {
      job: null | {
        messageId: string;
        terminal?: AiTerminalAction;
        mcp?: AiMcpAction;
      };
    } = { job: null };

    updateAiConversation(activeRequest.conversationId, (conversation) => {
      const userMessage = conversation.messages.find((message) => message.id === activeRequest.userMessageId);
      return {
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: conversation.messages.map((message) => {
          if (message.id !== activeRequest.assistantMessageId) return message;
          if (status === 'complete') {
            if (activeRequest.mode !== 'agent') {
              return { ...message, status, proposals: [], terminalActions: [], mcpActions: [] };
            }
            const responseContent = activeRequest.content || message.content;
            const parsedEdits = parseAiEditResponse(responseContent);
            const parsedTerminal = parseAiTerminalResponse(parsedEdits.visibleContent);
            const parsedMcp = parseAiMcpResponse(parsedTerminal.visibleContent);
            const nativeMapped = mapNativeToolCalls(activeRequest.toolCalls ?? []);
            const actionErrors = [
              ...parsedEdits.errors,
              ...parsedTerminal.errors,
              ...parsedMcp.errors,
              ...nativeMapped.errors,
            ];
            // 原生 tool_calls 优先；fence 作为兼容回退，再按 identity 去重
            const mergedTerminalSources = [
              ...nativeMapped.terminalActions,
              ...parsedTerminal.actions,
            ];
            const mergedMcpSources = [
              ...nativeMapped.mcpActions,
              ...parsedMcp.actions,
            ];
            const proposals = parsedEdits.proposals.flatMap<AiEditProposal>((proposal) => {
              const target = userMessage?.contexts.find((context) =>
                context.kind === 'file' && context.source === proposal.targetSource,
              );
              if (!target?.source) {
                actionErrors.push(`修改提案引用了未授权文件：${proposal.targetSource}`);
                return [];
              }
              return [{
                id: crypto.randomUUID(),
                summary: proposal.summary,
                targetSource: target.source,
                targetLabel: target.label,
                status: 'proposed',
                edits: proposal.edits,
                isRemote: target.isRemote,
                terminalId: target.terminalId,
                createdAt: new Date().toISOString(),
              }];
            });
            const priorTerminalCommandIds = new Set(
              conversation.messages.flatMap((priorMessage) =>
                priorMessage.terminalActions.map(({ command }) => terminalCommandIdentity(command)),
              ),
            );
            const acceptedTerminalCommandIds = new Set<string>();
            const authorizedTerminalContexts = (userMessage?.contexts ?? []).filter((context) =>
              (context.kind === 'terminal' || context.kind === 'selection')
              && Boolean(context.source)
              && Boolean(context.terminalId),
            );
            const terminalActions = mergedTerminalSources.flatMap<AiTerminalAction>((action) => {
              let target = authorizedTerminalContexts.find((context) =>
                context.source === action.contextSource,
              );
              // 仅有一个已授权终端时，容忍 AI 写错/写占位 context_source（如 terminal）
              if ((!target?.source || !target.terminalId) && authorizedTerminalContexts.length === 1) {
                target = authorizedTerminalContexts[0];
              }
              if (!target?.source || !target.terminalId) {
                actionErrors.push(`终端动作引用了未授权或不可用终端：${action.contextSource}`);
                return [];
              }
              const commandId = terminalCommandIdentity(action.command);
              if (priorTerminalCommandIds.has(commandId) || acceptedTerminalCommandIds.has(commandId)) {
                actionErrors.push('终端动作与本任务中已有提案重复，已停止无进展重试');
                return [];
              }
              const suspiciousRedirection = suspiciousShellRedirection(action.command);
              if (suspiciousRedirection) {
                actionErrors.push(`终端动作包含疑似粘连的 shell 重定向“${suspiciousRedirection}”，已拒绝提案`);
                return [];
              }
              acceptedTerminalCommandIds.add(commandId);
              return [{
                id: crypto.randomUUID(),
                summary: action.summary,
                contextSource: target.source,
                contextLabel: target.label,
                command: action.command,
                timeoutMs: action.timeoutMs,
                status: 'proposed',
                isRemote: Boolean(target.isRemote),
                terminalId: target.terminalId,
                toolCallId: action.toolCallId,
                createdAt: new Date().toISOString(),
              }];
            });
            const priorMcpIds = new Set(
              conversation.messages.flatMap((priorMessage) =>
                priorMessage.mcpActions.map(({ serverId, toolName, arguments: args }) =>
                  mcpActionIdentity(serverId, toolName, args),
                ),
              ),
            );
            const acceptedMcpIds = new Set<string>();
            const mcpActions = mergedMcpSources.flatMap<AiMcpAction>((action) => {
              const identity = mcpActionIdentity(action.serverId, action.toolName, action.arguments);
              if (priorMcpIds.has(identity) || acceptedMcpIds.has(identity)) {
                actionErrors.push('MCP 动作与本任务中已有提案重复，已停止无进展重试');
                return [];
              }
              acceptedMcpIds.add(identity);
              return [{
                id: crypto.randomUUID(),
                summary: action.summary,
                serverId: action.serverId,
                toolName: action.toolName,
                arguments: action.arguments,
                status: 'proposed',
                toolCallId: action.toolCallId,
                createdAt: new Date().toISOString(),
              }];
            });
            const isToolContinuation = userMessage?.contexts.some(({ label }) =>
              label.startsWith(AI_AGENT_RESULT_LABEL_PREFIX),
            ) ?? false;
            const declaresPendingToolWork = /(如果你(?:要我|愿意)|我会(?:直接)?提交|下一条会|需要.*(?:重新执行|再查|继续查)|可以直接再)/u.test(
              parsedMcp.visibleContent,
            );
            shouldRepairAgentProtocol = !activeRequest.protocolRepairAttempt
              && isToolContinuation
              && proposals.length === 0
              && terminalActions.length === 0
              && mcpActions.length === 0
              && declaresPendingToolWork;
            const errorSuffix = actionErrors.length > 0
              ? `\n\n动作未全部接受：${actionErrors.join('；')}`
              : '';

            // 自动执行：在同一同步解析结果上排队，不依赖尚未 re-render 的 workspace ref
            if (aiAutoRunEnabledRef.current && !shouldRepairAgentProtocol) {
              const autoTerminal = terminalActions.find((action) =>
                action.status === 'proposed' && !isHighRiskTerminalCommand(action.command),
              );
              if (autoTerminal) {
                autoRunCapture.job = { messageId: message.id, terminal: autoTerminal };
              } else {
                const autoMcp = mcpActions.find((action) => action.status === 'proposed');
                if (autoMcp) {
                  autoRunCapture.job = { messageId: message.id, mcp: autoMcp };
                }
              }
            }

            return {
              ...message,
              content: `${parsedMcp.visibleContent}${errorSuffix}`.trim(),
              proposals,
              terminalActions,
              mcpActions,
              status,
            };
          }
          const content = status === 'error'
            ? `${message.content}${message.content ? '\n\n' : ''}请求失败：${errorMessage}`
            : message.content;
          return { ...message, content, status };
        }),
      };
    });
    if (aiActiveRequestRef.current?.requestId === activeRequest.requestId) {
      aiActiveRequestRef.current = null;
      setIsAiGenerating(false);
    }
    if (shouldRepairAgentProtocol) {
      window.setTimeout(() => {
        if (aiActiveRequestRef.current) return;
        const workspace = aiWorkspaceRef.current;
        if (workspace.activeConversationId !== activeRequest.conversationId) return;
        const conversation = workspace.conversations.find(({ id }) => id === activeRequest.conversationId);
        if (!conversation || conversation.mode !== 'agent') return;
        const userMessage = conversation.messages.find(({ id }) => id === activeRequest.userMessageId);
        if (!userMessage) return;
        const baseMessages = conversation.messages.filter(({ id }) => id !== activeRequest.assistantMessageId);
        const repairMessage: AiMessage = {
          ...userMessage,
          content: `${userMessage.content}\n\n协议纠偏：上一回复表示仍需工具，却未提交 tool call。请立即调用 run_terminal_command 或 call_mcp_tool（无 tools 时用 pandaterm-terminal / pandaterm-mcp 代码块）；不要再次询问。`,
        };
        beginAiGeneration(conversation, baseMessages, repairMessage, true);
      }, 0);
      return;
    }
    // 低风险自动执行：用解析阶段捕获的动作对象，绕过 ref 时序问题
    if (autoRunCapture.job) {
      const job = autoRunCapture.job;
      window.setTimeout(() => {
        if (job.terminal) {
          runAiTerminalActionRef.current(
            activeRequest.conversationId,
            job.messageId,
            job.terminal,
          );
          return;
        }
        if (job.mcp) {
          void runAiMcpActionRef.current(
            activeRequest.conversationId,
            job.messageId,
            job.mcp,
          );
        }
      }, 0);
    }
    // 生成结束：冲刷排队消息（续跑/自动执行中若又起请求，队列会等下一轮）
    window.setTimeout(() => flushAiMessageQueueRef.current(), 40);
  }

  finishAiStreamRef.current = finishAiStream;

  function toggleLeftActivity(panel: 'files' | 'monitor' | 'processes' | 'ai') {
    // VSCode 风格：再次点击已激活的图标则收起侧边栏
    setLeftActivity(leftActivity === panel ? null : panel);
  }

  async function refreshAiProviderConfig(options?: { fillApiKey?: boolean }) {
    const generation = ++aiConfigRefreshGenerationRef.current;
    setIsAiConfigLoading(true);
    setAiConfigError('');
    try {
      const config = await getAiProviderConfig();
      if (generation !== aiConfigRefreshGenerationRef.current) return;
      applyAiProviderConfigState(config);
      // 设置弹窗打开期间始终回填；避免并发 refresh 不带 fill 时错过密钥
      const shouldFillApiKey = Boolean(options?.fillApiKey || isAiSettingsOpenRef.current);
      if (shouldFillApiKey) {
        const revealed = config.api_key?.trim() ?? '';
        aiApiKeyBaselineRef.current = revealed;
        setAiApiKeyDraft(revealed);
        if (config.api_key_configured && !revealed && !config.error) {
          setAiConfigError('已配置密钥，但当前进程未能解密回填。请完全重启 PandaTerm 后再打开设置。');
        }
      }
      if (config.error) setAiConfigError(config.error);
    } catch (error) {
      if (generation !== aiConfigRefreshGenerationRef.current) return;
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === aiConfigRefreshGenerationRef.current) {
        setIsAiConfigLoading(false);
      }
    }
  }

  function openAiSettings(tab: 'models' | 'mcp' = 'models') {
    // 独立 Tauri 窗口（轻量入口），禁止把 React 事件对象当 tab
    void openAiSettingsWindow(tab === 'mcp' ? 'mcp' : 'models');
  }

  function completeAiSettingsClose() {
    setIsAiSettingsOpen(false);
  }

  /** 关闭设置：Models/MCP 任一侧有未保存改动时确认 */
  function requestCloseAiSettings() {
    if (isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting || isMcpSaving || mcpBusyServerId) return;
    if (aiProviderTestDialog.open) {
      setAiProviderTestDialog({ open: false, lines: [], status: 'idle' });
      return;
    }
    const modelsDirty = isAiConfigDraftDirty(
      aiConfigDraft,
      aiApiKeyDraft,
      aiApiKeyBaselineRef.current,
      aiProviderConfig,
    );
    const mcpDirty = isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot);
    if (!modelsDirty && !mcpDirty) {
      completeAiSettingsClose();
      return;
    }
    const parts = [
      modelsDirty ? '模型' : null,
      mcpDirty ? 'MCP' : null,
    ].filter(Boolean).join(' / ');
    setConfirmDialog({
      title: '放弃未保存的更改？',
      message: `${parts} 有未保存的改动。关闭后将丢失这些草稿。`,
      confirmLabel: '放弃更改',
      danger: true,
      onConfirm: completeAiSettingsClose,
    });
  }

  openAiSettingsRef.current = openAiSettings;
  requestCloseAiSettingsRef.current = requestCloseAiSettings;

  async function refreshMcpConfig() {
    const generation = ++mcpRefreshGenerationRef.current;
    setIsMcpLoading(true);
    setMcpError('');
    try {
      const snapshot = await getMcpConfig();
      if (generation !== mcpRefreshGenerationRef.current) return;
      setMcpSnapshot(snapshot);
      setMcpServersDraft(snapshotToMcpDraft(snapshot));
      if (snapshot.error) setMcpError(snapshot.error);
    } catch (error) {
      if (generation !== mcpRefreshGenerationRef.current) return;
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === mcpRefreshGenerationRef.current) setIsMcpLoading(false);
    }
  }

  function updateMcpServerDraft(serverId: string, patch: Partial<McpServerConfig>) {
    setMcpServersDraft((current) => current.map((server) => (
      server.id === serverId ? { ...server, ...patch } : server
    )));
  }

  function openMcpServerJsonEditor(server: McpServerConfig) {
    setExpandedMcpServerId(server.id);
    setMcpEditJsonById((current) => ({
      ...current,
      [server.id]: formatMcpServerJson(server),
    }));
    setMcpEditJsonErrorById((current) => ({ ...current, [server.id]: '' }));
  }

  function syncMcpServerJsonEditor(server: McpServerConfig) {
    if (expandedMcpServerId !== server.id) return;
    setMcpEditJsonById((current) => ({
      ...current,
      [server.id]: formatMcpServerJson(server),
    }));
    setMcpEditJsonErrorById((current) => ({ ...current, [server.id]: '' }));
  }

  function applyMcpServerJsonText(serverId: string, text: string) {
    setMcpEditJsonById((current) => ({ ...current, [serverId]: text }));
    const isPersisted = Boolean(mcpSnapshot?.servers.some((item) => item.id === serverId));
    const otherIds = new Set(
      mcpServersDraft.filter((item) => item.id !== serverId).map((item) => item.id),
    );
    const parsed = parseMcpServerJsonText(text, {
      fallbackId: serverId,
      lockId: isPersisted,
    });
    if (!parsed.ok) {
      setMcpEditJsonErrorById((current) => ({ ...current, [serverId]: parsed.error }));
      return;
    }
    const nextId = isPersisted ? serverId : (parsed.server.id.trim() || serverId);
    if (!isPersisted && nextId !== serverId && otherIds.has(nextId)) {
      setMcpEditJsonErrorById((current) => ({
        ...current,
        [serverId]: `标识 ID「${nextId}」已存在`,
      }));
      return;
    }
    const nextServer: McpServerConfig = { ...parsed.server, id: nextId };
    setMcpEditJsonErrorById((current) => ({ ...current, [serverId]: '' }));
    setMcpServersDraft((current) => current.map((server) => (
      server.id === serverId ? nextServer : server
    )));
    if (nextId !== serverId) {
      setExpandedMcpServerId(nextId);
      setMcpEditJsonById((current) => {
        const { [serverId]: moved, ...rest } = current;
        return { ...rest, [nextId]: moved ?? text };
      });
      setMcpEditJsonErrorById((current) => {
        const { [serverId]: _removed, ...rest } = current;
        return rest;
      });
      setMcpToolsExpandedIds((current) => {
        if (!(serverId in current)) return current;
        const { [serverId]: moved, ...rest } = current;
        return { ...rest, [nextId]: moved };
      });
    }
  }

  /** 删除 MCP：确认后立即落盘（新草稿未入库则只移除草稿） */
  function requestRemoveMcpServer(serverId: string) {
    if (isMcpSaving || mcpBusyServerId) return;
    const server = mcpServersDraft.find((item) => item.id === serverId);
    if (!server) return;
    const label = server.name.trim() || server.id;
    const isPersisted = Boolean(mcpSnapshot?.servers.some((item) => item.id === server.id));
    setConfirmDialog({
      title: '删除 MCP 服务器',
      message: isPersisted
        ? `确定删除“${label}”并写入配置？已连接会话会断开。`
        : `确定移除未保存的“${label}”草稿？`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        let nextDraft: McpServerConfig[] = [];
        setMcpServersDraft((current) => {
          nextDraft = current.filter((item) => item.id !== serverId);
          return nextDraft;
        });
        setExpandedMcpServerId((current) => (current === serverId ? null : current));
        if (!isPersisted) return;
        setMcpBusyServerId(serverId);
        setIsMcpSaving(true);
        setMcpError('');
        try {
          const snapshot = await saveMcpConfig(nextDraft);
          setMcpSnapshot(snapshot);
          setMcpServersDraft(snapshotToMcpDraft(snapshot));
          if (snapshot.error) setMcpError(snapshot.error);
        } catch (error) {
          setMcpError(error instanceof Error ? error.message : String(error));
          void refreshMcpConfig();
        } finally {
          setIsMcpSaving(false);
          setMcpBusyServerId(null);
        }
      },
    });
  }

  /**
   * MCP 开关：立即落盘。
   * 开启且 stdio 时保存后自动 reconnect；关闭时仅保存（后端断开会话）。
   */
  async function toggleMcpServerEnabled(serverId: string) {
    if (isMcpSaving || mcpBusyServerId) return;
    const current = mcpServersDraft.find((server) => server.id === serverId);
    if (!current) return;

    const nextEnabled = !current.enabled;
    if (nextEnabled && current.transport === 'stdio' && !current.command.trim()) {
      setMcpError('请先填写启动命令，再启用该 MCP 服务器');
      openMcpServerJsonEditor(current);
      return;
    }
    if (nextEnabled && current.transport !== 'stdio' && !current.url.trim()) {
      setMcpError('请先填写服务地址，再启用远程 MCP 服务器');
      openMcpServerJsonEditor(current);
      return;
    }

    const nextDraft = mcpServersDraft.map((server) => (
      server.id === serverId ? { ...server, enabled: nextEnabled } : server
    ));
    setMcpServersDraft(nextDraft);
    setMcpBusyServerId(serverId);
    setMcpError('');
    setIsMcpSaving(true);
    try {
      const saved = await saveMcpConfig(nextDraft);
      setMcpSnapshot(saved);
      setMcpServersDraft(snapshotToMcpDraft(saved));
      if (saved.error) setMcpError(saved.error);

      if (nextEnabled && (current.transport === 'stdio' || current.transport === 'streamable-http' || current.transport === 'sse')) {
        const snapshot = await reconnectMcpServer(serverId);
        setMcpSnapshot(snapshot);
        setMcpServersDraft(snapshotToMcpDraft(snapshot));
        if (snapshot.error) setMcpError(snapshot.error);
      }
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
      void refreshMcpConfig();
    } finally {
      setIsMcpSaving(false);
      setMcpBusyServerId(null);
    }
  }

  async function submitMcpConfig() {
    if (isMcpSaving) return;
    setIsMcpSaving(true);
    setMcpError('');
    try {
      // 启用态缺少必要字段不允许保存
      const invalidStdio = mcpServersDraft.find((server) => (
        server.enabled
        && server.transport === 'stdio'
        && !server.command.trim()
      ));
      if (invalidStdio) {
        setExpandedMcpServerId(invalidStdio.id);
        throw new Error(`MCP “${invalidStdio.name.trim() || invalidStdio.id}” 已启用但缺少启动命令`);
      }
      const invalidRemote = mcpServersDraft.find((server) => (
        server.enabled
        && server.transport !== 'stdio'
        && !server.url.trim()
      ));
      if (invalidRemote) {
        setExpandedMcpServerId(invalidRemote.id);
        throw new Error(`MCP “${invalidRemote.name.trim() || invalidRemote.id}” 已启用但缺少服务地址`);
      }
      const snapshot = await saveMcpConfig(mcpServersDraft);
      setMcpSnapshot(snapshot);
      setMcpServersDraft(snapshotToMcpDraft(snapshot));
      if (snapshot.error) setMcpError(snapshot.error);
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMcpSaving(false);
    }
  }

  async function reconnectMcpServerDraft(serverId: string) {
    if (isMcpSaving || mcpBusyServerId) return;
    setMcpBusyServerId(serverId);
    setMcpError('');
    try {
      // 先保存草稿，再重连，避免 UI 与磁盘不一致
      const saved = await saveMcpConfig(mcpServersDraft);
      setMcpServersDraft(snapshotToMcpDraft(saved));
      const snapshot = await reconnectMcpServer(serverId);
      setMcpSnapshot(snapshot);
      setMcpServersDraft(snapshotToMcpDraft(snapshot));
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
      void refreshMcpConfig();
    } finally {
      setMcpBusyServerId(null);
    }
  }

  async function openMcpImportPanel() {
    if (isMcpLoading || isMcpSaving || isMcpImporting) return;
    setMcpPane('installed');
    if (mcpImportOpen) {
      setMcpImportOpen(false);
      return;
    }
    setMcpImportOpen(true);
    setMcpError('');
    setMcpNotice('');
    try {
      const candidates = await listMcpImportCandidates();
      setMcpImportCandidates(candidates);
      const preferred = candidates.find((item) => item.exists && !item.error)
        ?? candidates.find((item) => item.exists);
      if (preferred && !mcpImportPath.trim()) {
        setMcpImportPath(preferred.path);
      }
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    }
  }

  function switchMcpPane(pane: 'installed' | 'market') {
    if (isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting) return;
    setMcpPane(pane);
    if (pane === 'market') {
      setMcpImportOpen(false);
    }
    setMcpError('');
    setMcpNotice('');
  }

  /** 从市场添加草稿：同 id 已存在则展开已有项；否则追加（默认不启用） */
  function addMcpFromMarket(item: McpMarketItem) {
    if (isMcpSaving || mcpBusyServerId) return;
    const existing = mcpServersDraft.find((server) => server.id === item.id);
    if (existing) {
      setMcpPane('installed');
      openMcpServerJsonEditor(existing);
      setMcpNotice(`「${item.name}」已在列表中，已切换到已安装并展开。`);
      return;
    }
    const draft = marketItemToServerConfig(item);
    setMcpServersDraft((current) => [...current, draft]);
    setMcpPane('installed');
    openMcpServerJsonEditor(draft);
    setMcpError('');
    const tips: string[] = [];
    if (item.requiresEnv?.length) tips.push(`请填写环境变量：${item.requiresEnv.join('、')}`);
    if (item.requiresArgs) tips.push('请按本机路径调整启动参数');
    if (item.note) tips.push(item.note);
    setMcpNotice(
      tips.length > 0
        ? `已添加「${item.name}」到草稿（未启用）。${tips.join('；')}。确认后点击「保存 MCP」。`
        : `已添加「${item.name}」到草稿（未启用）。确认配置后点击「保存 MCP」，再开关启用连接。`,
    );
  }

  async function importMcpFromPath(path: string) {
    const target = path.trim();
    if (!target || isMcpImporting || isMcpSaving) return;
    setIsMcpImporting(true);
    setMcpError('');
    setMcpNotice('');
    try {
      const preview = await importMcpServersFromPath(target);
      const { next, added, updated, skipped } = mergeMcpServerImports(
        mcpServersDraft,
        preview.servers,
        mcpImportStrategy,
      );
      if (added === 0 && updated === 0) {
        setMcpError(
          skipped > 0
            ? `没有可合并的 MCP 服务器（已跳过 ${skipped} 个同名项）`
            : '没有可合并的 MCP 服务器',
        );
        return;
      }
      setMcpServersDraft(next);
      setExpandedMcpServerId(preview.servers[0]?.id ?? null);
      setMcpImportOpen(false);
      const parts = [`新增 ${added}`];
      if (mcpImportStrategy === 'overwrite') parts.push(`覆盖 ${updated}`);
      if (skipped > 0) parts.push(`跳过 ${skipped}`);
      setMcpNotice(
        `已导入 ${preview.server_count} 个服务器（${parts.join(' · ')}）。请检查后点击「保存 MCP」。`,
      );
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMcpImporting(false);
    }
  }

  async function exportMcpCursorJson() {
    if (isMcpExporting || isMcpSaving || mcpServersDraft.length === 0) return;
    setIsMcpExporting(true);
    setMcpError('');
    setMcpNotice('');
    try {
      const text = await exportMcpServersCursorJson(mcpServersDraft);
      let copied = false;
      try {
        await writeClipboardText(text);
        copied = true;
      } catch {
        copied = false;
      }
      // 同时触发下载，便于落到磁盘
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mcp.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMcpNotice(
        copied
          ? `已导出 ${mcpServersDraft.length} 个服务器为 Cursor mcp.json（已复制并下载）`
          : `已导出 ${mcpServersDraft.length} 个服务器为 Cursor mcp.json（已下载）`,
      );
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMcpExporting(false);
    }
  }

  function applyAiProviderConfigState(config: AiProviderConfig) {
    const catalog = resolveAiModelCatalog(config);
    setAiProviderConfig(aiConfigToProviderState(config));
    setAiConfigDraft(aiConfigToDraft(config));
    setAiTestModel((current) => resolveAiTestModel(catalog.models, current, catalog.model));
    return catalog;
  }

  function fillAiApiKeyFromConfig(config: AiProviderConfig) {
    const revealed = config.api_key?.trim() ?? '';
    aiApiKeyBaselineRef.current = revealed;
    setAiApiKeyDraft(revealed);
    setIsAiApiKeyVisible(false);
  }

  /** 切换 / 添加 / 删除账号前：未保存草稿则确认放弃 */
  function withAiAccountSwitchGuard(action: () => void | Promise<void>) {
    const dirty = isAiConfigDraftDirty(
      aiConfigDraft,
      aiApiKeyDraft,
      aiApiKeyBaselineRef.current,
      aiProviderConfig,
    );
    if (!dirty) {
      void action();
      return;
    }
    setConfirmDialog({
      title: '放弃未保存的更改？',
      message: '当前账号有未保存的改动。切换后将丢失这些草稿。',
      confirmLabel: '放弃并继续',
      danger: true,
      onConfirm: () => { void action(); },
    });
  }

  async function addAiAccount() {
    if (isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting) return;
    withAiAccountSwitchGuard(async () => {
      setIsAiConfigLoading(true);
      setAiConfigError('');
      try {
        const config = await addAiProviderAccount();
        applyAiProviderConfigState(config);
        fillAiApiKeyFromConfig(config);
        setAiSettingsApiKeysOpen(true);
      } catch (error) {
        setAiConfigError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsAiConfigLoading(false);
      }
    });
  }

  async function switchAiAccount(accountId: string) {
    const nextId = accountId.trim();
    if (!nextId || nextId === (aiConfigDraft.account_id || '').trim()) return;
    if (isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting) return;
    withAiAccountSwitchGuard(async () => {
      setIsAiConfigLoading(true);
      setAiConfigError('');
      try {
        const config = await setActiveAiProviderAccount(nextId);
        applyAiProviderConfigState(config);
        fillAiApiKeyFromConfig(config);
        if (config.api_key_configured && !(config.api_key?.trim()) && !config.error) {
          setAiConfigError('已配置密钥，但当前进程未能解密回填。请完全重启 PandaTerm 后再打开设置。');
        }
      } catch (error) {
        setAiConfigError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsAiConfigLoading(false);
      }
    });
  }

  async function removeAiAccount(accountId: string) {
    const targetId = accountId.trim();
    if (!targetId) return;
    if ((aiProviderConfig?.accounts?.length ?? 0) <= 1) {
      setAiConfigError('至少保留一个 AI 账号');
      return;
    }
    if (isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting) return;
    setConfirmDialog({
      title: '删除账号？',
      message: '将删除该账号的接口与密钥配置，且不可恢复。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        void (async () => {
          setIsAiConfigLoading(true);
          setAiConfigError('');
          try {
            const config = await deleteAiProviderAccount(targetId);
            applyAiProviderConfigState(config);
            fillAiApiKeyFromConfig(config);
          } catch (error) {
            setAiConfigError(error instanceof Error ? error.message : String(error));
          } finally {
            setIsAiConfigLoading(false);
          }
        })();
      },
    });
  }

  /** 设置当前模型（自动加入聊天可见列表） */
  function setAiDraftCurrentModel(model: string) {
    const nextModel = model.trim();
    if (!nextModel) return;
    setAiConfigDraft((current) => {
      const models = current.models.includes(nextModel)
        ? current.models
        : [...current.models, nextModel];
      const enabled_models = current.enabled_models.includes(nextModel)
        ? current.enabled_models
        : [...current.enabled_models, nextModel];
      return { ...current, model: nextModel, models, enabled_models };
    });
  }

  /** 切换模型是否出现在聊天下拉；当前模型不可取消 */
  function toggleAiDraftEnabledModel(model: string) {
    const target = model.trim();
    if (!target) return;
    setAiConfigDraft((current) => {
      if (!current.models.includes(target)) return current;
      const isEnabled = current.enabled_models.includes(target);
      if (isEnabled) {
        if (target === current.model || current.enabled_models.length <= 1) return current;
        return {
          ...current,
          enabled_models: current.enabled_models.filter((item) => item !== target),
        };
      }
      return {
        ...current,
        enabled_models: [...current.enabled_models, target],
      };
    });
  }

  async function submitAiProviderConfig() {
    if (isAiConfigSaving) return;
    const apiKey = aiApiKeyDraft;
    setIsAiConfigSaving(true);
    setAiConfigError('');
    try {
      const catalog = resolveAiModelCatalog(aiConfigDraft);
      const config = await saveAiProviderConfig({
        account_id: aiConfigDraft.account_id || undefined,
        account_name: aiConfigDraft.account_name.trim() || '默认',
        base_url: aiConfigDraft.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        reasoning_effort: aiProviderConfig?.reasoning_effort ?? 'none',
        api_format: aiConfigDraft.api_format,
        use_api_key: true,
      }, apiKey);
      applyAiProviderConfigState(config);
      aiApiKeyBaselineRef.current = '';
      setAiApiKeyDraft('');
      setIsAiApiKeyVisible(false);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiConfigSaving(false);
    }
  }

  async function syncAiModelsFromProvider() {
    if (isAiModelsSyncing || isAiConfigSaving) return;
    const apiKey = aiApiKeyDraft;
    setIsAiModelsSyncing(true);
    setAiConfigError('');
    try {
      const config = await syncAiProviderModels({
        account_id: aiConfigDraft.account_id || null,
        base_url: aiConfigDraft.base_url,
        use_api_key: true,
        api_key: apiKey || null,
        api_format: aiConfigDraft.api_format,
      });
      const catalog = resolveAiModelCatalog(config);
      const preferredModel = catalog.models.includes(aiConfigDraft.model) ? aiConfigDraft.model : catalog.model;
      const nextCatalog = resolveAiModelCatalog({
        model: preferredModel,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
      });
      // 同步后保留多账号元数据，仅更新模型目录
      setAiProviderConfig(aiConfigToProviderState({
        ...config,
        model: nextCatalog.model,
        models: nextCatalog.models,
        enabled_models: nextCatalog.enabled_models,
      }));
      setAiConfigDraft((current) => ({
        ...aiConfigToDraft({
          ...config,
          model: nextCatalog.model,
          models: nextCatalog.models,
          enabled_models: nextCatalog.enabled_models,
        }),
        // 名称以用户当前草稿为准（未保存改名）
        account_name: current.account_name,
      }));
      setAiTestModel((current) => resolveAiTestModel(nextCatalog.models, current, nextCatalog.model));
      if (config.api_key) {
        const revealed = config.api_key.trim();
        aiApiKeyBaselineRef.current = revealed;
        setAiApiKeyDraft(revealed);
      }
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiModelsSyncing(false);
    }
  }

  async function runAiProviderTest() {
    if (isAiProviderTesting || isAiConfigSaving || isAiModelsSyncing) return;
    const model = resolveAiTestModel(aiConfigDraft.models, aiTestModel, aiConfigDraft.model);
    if (!model) {
      setAiConfigError('请先选择或填写要测试的模型');
      return;
    }
    if (!aiConfigDraft.base_url.trim()) {
      setAiConfigError('请先填写接口地址');
      return;
    }
    const baseUrl = aiConfigDraft.base_url.trim();
    const apiFormat = aiConfigDraft.api_format;
    setIsAiProviderTesting(true);
    setAiConfigError('');
    setAiProviderTestDialog({
      open: true,
      status: 'running',
      lines: buildAiProviderTestLog({
        phase: 'start',
        model,
        baseUrl,
        apiFormat,
      }),
    });
    try {
      const result = await testAiProvider({
        base_url: baseUrl,
        model,
        api_format: apiFormat,
        use_api_key: true,
        api_key: aiApiKeyDraft || null,
      });
      setAiProviderTestDialog({
        open: true,
        status: 'done',
        lines: buildAiProviderTestLog({
          phase: 'success',
          model: result.model || model,
          baseUrl: result.base_url || baseUrl,
          apiFormat: result.api_format || apiFormat,
          content: result.content,
          ttftMs: result.ttft_ms,
          totalMs: result.total_ms,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiProviderTestDialog({
        open: true,
        status: 'error',
        lines: buildAiProviderTestLog({
          phase: 'error',
          model,
          baseUrl,
          apiFormat,
          error: message,
        }),
      });
    } finally {
      setIsAiProviderTesting(false);
    }
  }

  async function selectAiProviderAccountInChat(accountId: string) {
    const nextId = accountId.trim();
    if (!nextId || !aiProviderConfig || isAiGenerating || isAiConfigSaving) return;
    const currentId = (aiProviderConfig.account_id || aiProviderConfig.active_account_id || '').trim();
    if (nextId === currentId) return;
    setAiConfigError('');
    try {
      const config = await setActiveAiProviderAccount(nextId);
      applyAiProviderConfigState(config);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectAiModel(model: string) {
    const nextModel = model.trim();
    if (!nextModel || !aiProviderConfig || isAiGenerating || isAiConfigSaving) return;
    if (nextModel === aiProviderConfig.model) return;
    setAiConfigError('');
    try {
      const catalog = resolveAiModelCatalog({
        model: nextModel,
        models: aiProviderConfig.models,
        enabled_models: aiProviderConfig.enabled_models,
      });
      const config = await saveAiProviderConfig({
        account_id: aiProviderConfig.account_id || aiProviderConfig.active_account_id || undefined,
        account_name: aiProviderConfig.account_name || undefined,
        base_url: aiProviderConfig.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        reasoning_effort: aiProviderConfig.reasoning_effort,
        api_format: normalizeAiApiFormat(aiProviderConfig.api_format),
        use_api_key: true,
      });
      applyAiProviderConfigState(config);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectAiReasoningEffort(effort: AiReasoningEffort) {
    if (!aiProviderConfig || isAiGenerating || isAiConfigSaving) return;
    const nextEffort = normalizeAiReasoningEffort(effort);
    if (nextEffort === normalizeAiReasoningEffort(aiProviderConfig.reasoning_effort)) return;
    setAiConfigError('');
    try {
      const config = await saveAiProviderConfig({
        account_id: aiProviderConfig.account_id || aiProviderConfig.active_account_id || undefined,
        account_name: aiProviderConfig.account_name || undefined,
        base_url: aiProviderConfig.base_url,
        model: aiProviderConfig.model,
        models: aiProviderConfig.models,
        enabled_models: aiProviderConfig.enabled_models,
        reasoning_effort: nextEffort,
        api_format: normalizeAiApiFormat(aiProviderConfig.api_format),
        use_api_key: true,
      });
      applyAiProviderConfigState(config);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  function addPendingAiContext(context: AiContextItem) {
    setPendingAiContexts((current) => [
      ...current.filter((item) => `${item.kind}:${item.source ?? item.label}` !== `${context.kind}:${context.source ?? context.label}`),
      context,
    ]);
    setIsAiMentionOpen(false);
    setAiInput((current) => current.replace(/(^|\s)@[^\s@]*$/, '$1'));
  }

  async function requestAiContext(kind: AiContextKind, resource?: ResourceFile) {
    const terminalTabId = activePaneTabRef.current?.id ?? null;
    const editorTabId = activeEditorTabId;
    const targetTerminalId = activePaneTabRef.current?.terminalId ?? null;
    const targetIsLocal = isLocalResourceTab(activePaneTabRef.current);
    const label = resource?.name
      ?? (kind === 'terminal' ? '当前终端输出' : kind === 'selection' ? '终端选中文本' : '当前编辑器文件');

    try {
      if (resource) {
        const preview = targetIsLocal
          ? await readLocalFileFull(resource.path)
          : targetTerminalId
            ? await readRemoteFileFull(targetTerminalId, resource.path)
            : null;
        if (!preview) throw new Error('目标终端已经不可用');
        addPendingAiContext({
          kind: 'file',
          label: resource.name,
          source: resource.path,
          preview: preview.content.slice(0, 8000),
          isRemote: !targetIsLocal,
          terminalId: targetTerminalId ?? undefined,
        });
        return;
      }
      if (kind === 'terminal') {
        const tab = tabsRef.current.find((item) => item.id === terminalTabId);
        if (!tab) throw new Error('目标终端已经关闭');
        const recentOutput = tab.output.join('').slice(-6000).trim();
        addPendingAiContext({
          kind,
          label: tab.title || tab.session.name,
          source: tab.id,
          preview: recentOutput || `${tab.statusMessage}\n状态：${tab.status}`,
          isRemote: !targetIsLocal,
          terminalId: targetTerminalId ?? undefined,
        });
        return;
      }
      if (kind === 'selection') {
        const selection = terminalTabId
          ? terminalsRef.current.get(terminalTabId)?.getSelection().trim() ?? ''
          : '';
        if (!selection) throw new Error('终端选中文本已经不可用');
        addPendingAiContext({
          kind,
          label,
          source: terminalTabId ?? undefined,
          preview: selection.slice(0, 4000),
          isRemote: !targetIsLocal,
          terminalId: targetTerminalId ?? undefined,
        });
        return;
      }
      const editorTab = editorTabs.find((tab) => tab.id === editorTabId);
      if (!editorTab) throw new Error('目标编辑器文件已经关闭');
      addPendingAiContext({
        kind,
        label: editorTab.name,
        source: editorTab.path,
        preview: editorTab.content.slice(0, 8000),
        isRemote: editorTab.isRemote,
        terminalId: editorTab.terminalId,
      });
    } catch (error) {
      setAiConversationError(error instanceof Error ? error.message : String(error));
    }
  }

  function beginAiGeneration(
    conversation: AiConversationState,
    baseMessages: AiMessage[],
    userMessage: AiMessage,
    protocolRepairAttempt = false,
  ) {
    const requestId = crypto.randomUUID();
    const assistantMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      contexts: [],
      proposals: [],
      terminalActions: [],
      mcpActions: [],
      createdAt: new Date().toISOString(),
      status: 'streaming',
    };
    const userIndex = baseMessages.findIndex((message) => message.id === userMessage.id);
    const history = userIndex >= 0 ? baseMessages.slice(0, userIndex) : baseMessages;
    aiActiveRequestRef.current = {
      requestId,
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      userMessageId: userMessage.id,
      mode: conversation.mode,
      content: '',
      toolCalls: [],
      protocolRepairAttempt,
    };
    updateAiConversation(conversation.id, (current) => ({
      ...current,
      title: current.title === '新对话' ? userMessage.content.slice(0, 36) : current.title,
      updatedAt: new Date().toISOString(),
      messages: [...baseMessages, assistantMessage],
    }));
    setIsAiGenerating(true);
    void (async () => {
      let mcpCatalog = '';
      if (conversation.mode === 'agent') {
        try {
          mcpCatalog = formatMcpToolsCatalog(await listMcpTools());
        } catch {
          mcpCatalog = '';
        }
      }
      if (aiActiveRequestRef.current?.requestId !== requestId) return;
      const requestMessages = buildAiRequestMessages(history, userMessage, conversation.mode, mcpCatalog);
      try {
        await streamAiChat(requestId, requestMessages, conversation.mode);
      } catch (error) {
        const activeRequest = aiActiveRequestRef.current;
        if (activeRequest?.requestId === requestId) {
          finishAiStream(activeRequest, 'error', error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }

  async function submitAiMessage() {
    const content = aiInput.trim();
    if (!content || !activeAiConversation) return;
    if (!aiProviderConfig
      || aiProviderConfig.error
      || !aiProviderConfig.api_key_configured) {
      openAiSettings();
      setAiConfigError(aiProviderConfig?.error ?? (aiProviderConfig ? '请先配置 API Key' : '请先完成 AI 供应商配置'));
      return;
    }

    const messageContexts = [...pendingAiContexts];
    if (activeAiConversation.mode === 'agent'
      && !messageContexts.some(({ kind }) => kind === 'terminal' || kind === 'selection')) {
      const terminalTab = activePaneTabRef.current;
      if (terminalTab && terminalTab.kind === 'terminal' && terminalTab.status === 'connected') {
        messageContexts.push({
          kind: 'terminal',
          label: `${terminalTab.title || terminalTab.session.name}（仅终端目标，未读取输出）`,
          source: terminalTab.id,
          preview: `terminal_target_only: true\nstatus: ${terminalTab.status}\noutput_authorized: false`,
          isRemote: !isLocalResourceTab(terminalTab),
          terminalId: terminalTab.terminalId,
        });
      }
    }

    // 生成中：入队，避免打断当前流式
    if (isAiGenerating || aiActiveRequestRef.current) {
      setAiMessageQueue((queue) => [
        ...queue,
        { id: crypto.randomUUID(), content, contexts: messageContexts },
      ]);
      setAiInput('');
      setPendingAiContexts([]);
      return;
    }

    const userMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      contexts: messageContexts,
      proposals: [],
      terminalActions: [],
      mcpActions: [],
      createdAt: new Date().toISOString(),
      status: 'complete',
    };
    setAiInput('');
    setPendingAiContexts([]);
    beginAiGeneration(activeAiConversation, [...activeAiConversation.messages, userMessage], userMessage);
  }

  function flushAiMessageQueue() {
    if (aiActiveRequestRef.current || isAiGenerating) return;
    const conversation = activeAiConversation;
    if (!conversation) return;
    setAiMessageQueue((queue) => {
      if (queue.length === 0) return queue;
      const [next, ...rest] = queue;
      const userMessage: AiMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: next.content,
        contexts: next.contexts,
        proposals: [],
        terminalActions: [],
        mcpActions: [],
        createdAt: new Date().toISOString(),
        status: 'complete',
      };
      window.setTimeout(() => {
        const current = aiWorkspaceRef.current.conversations.find(({ id }) => id === conversation.id);
        if (!current || aiActiveRequestRef.current) return;
        beginAiGeneration(current, [...current.messages, userMessage], userMessage);
      }, 0);
      return rest;
    });
  }
  flushAiMessageQueueRef.current = flushAiMessageQueue;

  async function stopCurrentAiGeneration() {
    const activeRequest = aiActiveRequestRef.current;
    if (!activeRequest) return;
    setIsAiGenerating(false);
    try {
      await stopAiChat(activeRequest.requestId);
    } catch (error) {
      finishAiStream(activeRequest, 'error', error instanceof Error ? error.message : String(error));
    }
  }

  function updateAiTerminalAction(
    conversationId: string,
    messageId: string,
    actionId: string,
    updater: (action: AiTerminalAction) => AiTerminalAction,
  ) {
    updateAiConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) => message.id === messageId
        ? {
          ...message,
          terminalActions: message.terminalActions.map((action) => action.id === actionId ? updater(action) : action),
        }
        : message),
    }));
  }

  async function runAiTerminalAction(
    conversationId: string,
    messageId: string,
    action: AiTerminalAction,
  ) {
    if (!['proposed', 'timeout', 'error'].includes(action.status)) return;
    updateAiTerminalAction(conversationId, messageId, action.id, (current) => ({
      ...current,
      status: 'running',
      output: undefined,
      exitCode: undefined,
      truncated: undefined,
      error: undefined,
    }));
    try {
      const result = await runAiTerminalCommand({
        terminal_id: action.terminalId,
        is_remote: action.isRemote,
        command: action.command,
        timeout_ms: action.timeoutMs,
      });
      const completedAction: AiTerminalAction = {
        ...action,
        status: result.timed_out ? 'timeout' : 'completed',
        output: result.output,
        exitCode: result.exit_code,
        truncated: result.truncated,
        error: result.timed_out ? result.output : undefined,
      };
      updateAiTerminalAction(conversationId, messageId, action.id, () => completedAction);
      continueAgentAfterTerminal(conversationId, messageId, completedAction);
    } catch (error) {
      updateAiTerminalAction(conversationId, messageId, action.id, (current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  runAiTerminalActionRef.current = (conversationId, messageId, action) => {
    void runAiTerminalAction(conversationId, messageId, action);
  };

  function rejectAiTerminalAction(messageId: string, action: AiTerminalAction) {
    if (!activeAiConversation || action.status === 'running' || action.status === 'completed') return;
    updateAiTerminalAction(activeAiConversation.id, messageId, action.id, (current) => ({
      ...current,
      status: 'rejected',
      output: undefined,
      error: undefined,
    }));
  }

  function updateAiMcpAction(
    conversationId: string,
    messageId: string,
    actionId: string,
    updater: (action: AiMcpAction) => AiMcpAction,
  ) {
    updateAiConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) => message.id === messageId
        ? {
          ...message,
          mcpActions: message.mcpActions.map((action) => action.id === actionId ? updater(action) : action),
        }
        : message),
    }));
  }

  async function runAiMcpAction(
    conversationId: string,
    messageId: string,
    action: AiMcpAction,
  ) {
    if (!['proposed', 'error'].includes(action.status)) return;
    updateAiMcpAction(conversationId, messageId, action.id, (current) => ({
      ...current,
      status: 'running',
      content: undefined,
      isError: undefined,
      error: undefined,
    }));
    try {
      const result = await callMcpTool({
        server_id: action.serverId,
        tool_name: action.toolName,
        arguments: action.arguments,
      });
      const completedAction: AiMcpAction = {
        ...action,
        status: result.is_error ? 'error' : 'completed',
        content: result.content,
        isError: result.is_error,
        error: result.is_error ? result.content : undefined,
      };
      updateAiMcpAction(conversationId, messageId, action.id, () => completedAction);
      if (!result.is_error) {
        continueAgentAfterMcp(conversationId, messageId, completedAction);
      }
    } catch (error) {
      updateAiMcpAction(conversationId, messageId, action.id, (current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  runAiMcpActionRef.current = runAiMcpAction;

  function rejectAiMcpAction(messageId: string, action: AiMcpAction) {
    if (!activeAiConversation || action.status === 'running' || action.status === 'completed') return;
    updateAiMcpAction(activeAiConversation.id, messageId, action.id, (current) => ({
      ...current,
      status: 'rejected',
      content: undefined,
      error: undefined,
    }));
  }

  function continueAgentAfterMcp(conversationId: string, messageId: string, action: AiMcpAction) {
    const workspace = aiWorkspaceRef.current;
    if (workspace.activeConversationId !== conversationId || aiActiveRequestRef.current) return;
    const conversation = workspace.conversations.find((current) => current.id === conversationId);
    if (!conversation || conversation.mode !== 'agent' || action.status !== 'completed' || action.continued) return;
    if (!canContinueAiAgent(conversation)) return;
    const output = action.content?.trim() || 'MCP 工具未产生输出';
    const baseMessages = conversation.messages.map((message) => message.id === messageId
      ? {
        ...message,
        mcpActions: message.mcpActions.map((current) => current.id === action.id
          ? { ...action, continued: true }
          : current),
      }
      : message);
    const userMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: buildAgentContinuationPrompt('mcp'),
      contexts: [{
        kind: 'terminal',
        label: `${AI_AGENT_RESULT_LABEL_PREFIX}MCP 结果：${action.summary}`,
        source: `mcp:${action.serverId}/${action.toolName}`,
        preview: `tool_action_id: ${action.id}\nserver: ${action.serverId}\ntool: ${action.toolName}\narguments: ${JSON.stringify(action.arguments)}\nis_error: false\noutput:\n${output.slice(-8000)}`,
      }],
      proposals: [],
      terminalActions: [],
      mcpActions: [],
      createdAt: new Date().toISOString(),
      status: 'complete',
    };
    beginAiGeneration(conversation, [...baseMessages, userMessage], userMessage);
  }

  function continueAgentAfterTerminal(conversationId: string, messageId: string, action: AiTerminalAction) {
    const workspace = aiWorkspaceRef.current;
    if (workspace.activeConversationId !== conversationId || aiActiveRequestRef.current) return;
    const conversation = workspace.conversations.find((current) => current.id === conversationId);
    if (!conversation || conversation.mode !== 'agent' || !['completed', 'timeout'].includes(action.status) || action.continued) return;
    if (!canContinueAiAgent(conversation)) return;
    const output = action.output?.trim() || '命令未产生输出';
    const baseMessages = conversation.messages.map((message) => message.id === messageId
      ? {
        ...message,
        terminalActions: message.terminalActions.map((current) => current.id === action.id
          ? { ...action, continued: true }
          : current),
      }
      : message);
    const userMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: buildAgentContinuationPrompt('terminal'),
      contexts: [{
        kind: 'terminal',
        label: `${AI_AGENT_RESULT_LABEL_PREFIX}工具结果：${action.summary}`,
        source: action.contextSource,
        preview: `tool_action_id: ${action.id}\ncommand: ${action.command}\nexit_code: ${action.exitCode ?? 'unknown'}\ntimed_out: ${action.status === 'timeout'}\ntruncated: ${Boolean(action.truncated)}\noutput:\n${output.slice(-8000)}`,
        isRemote: action.isRemote,
        terminalId: action.terminalId,
      }],
      proposals: [],
      terminalActions: [],
      mcpActions: [],
      createdAt: new Date().toISOString(),
      status: 'complete',
    };
    beginAiGeneration(conversation, [...baseMessages, userMessage], userMessage);
  }

  function continueAgentAfterEdit(messageId: string, proposal: AiEditProposal) {
    if (!activeAiConversation || activeAiConversation.mode !== 'agent' || proposal.status !== 'applied' || proposal.continued || isAiGenerating) return;
    if (!canContinueAiAgent(activeAiConversation)) return;
    const conversation = activeAiConversation;
    setConfirmDialog({
      title: '将修改结果发送给 Agent',
      message: `通知 AI“${proposal.summary}”已经应用到“${proposal.targetLabel}”，由它判断任务是否完成或提出下一步。`,
      confirmLabel: '发送并继续',
      onConfirm: () => {
        const baseMessages = conversation.messages.map((message) => message.id === messageId
          ? {
            ...message,
            proposals: message.proposals.map((current) => current.id === proposal.id
              ? { ...current, continued: true }
              : current),
          }
          : message);
        const userMessage: AiMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: buildAgentContinuationPrompt('edit'),
          contexts: [{
            kind: 'file',
            label: `${AI_AGENT_RESULT_LABEL_PREFIX}修改结果：${proposal.targetLabel}`,
            source: proposal.targetSource,
            preview: `applied: true\nsummary: ${proposal.summary}\ntarget: ${proposal.targetSource}`,
            isRemote: proposal.isRemote,
            terminalId: proposal.terminalId,
          }],
          proposals: [],
          terminalActions: [],
          mcpActions: [],
          createdAt: new Date().toISOString(),
          status: 'complete',
        };
        beginAiGeneration(conversation, [...baseMessages, userMessage], userMessage);
      },
    });
  }

  function updateAiProposal(
    conversationId: string,
    messageId: string,
    proposalId: string,
    updater: (proposal: AiEditProposal) => AiEditProposal,
  ) {
    updateAiConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) => message.id === messageId
        ? { ...message, proposals: message.proposals.map((proposal) => proposal.id === proposalId ? updater(proposal) : proposal) }
        : message),
    }));
  }

  function reviewAiEditProposal(messageId: string, proposal: AiEditProposal) {
    if (!activeAiConversation || !['proposed', 'error', 'stale'].includes(proposal.status)) return;
    const conversationId = activeAiConversation.id;
    setConfirmDialog({
      title: '允许读取文件并生成 Diff',
      message: `PandaTerm 将重新读取“${proposal.targetLabel}”以校验 AI 修改。读取结果仅保留在当前运行内存，不写入会话历史。`,
      confirmLabel: '允许读取',
      onConfirm: async () => {
        updateAiProposal(conversationId, messageId, proposal.id, (current) => ({ ...current, status: 'reading', error: undefined }));
        try {
          const full = proposal.isRemote
            ? proposal.terminalId
              ? await readRemoteFileFull(proposal.terminalId, proposal.targetSource)
              : null
            : await readLocalFileFull(proposal.targetSource);
          if (!full) throw new Error('目标终端已经不可用');
          const nextContent = applyExactEdits(full.content, proposal.edits);
          if (nextContent === full.content) throw new Error('修改提案不会改变文件内容');
          updateAiProposal(conversationId, messageId, proposal.id, (current) => ({
            ...current,
            status: 'ready',
            baseContent: full.content,
            nextContent,
            error: undefined,
          }));
        } catch (error) {
          updateAiProposal(conversationId, messageId, proposal.id, (current) => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    });
  }

  function rejectAiEditProposal(messageId: string, proposal: AiEditProposal) {
    if (!activeAiConversation || ['applied', 'applying', 'rejected'].includes(proposal.status)) return;
    updateAiProposal(activeAiConversation.id, messageId, proposal.id, (current) => ({
      ...current,
      status: 'rejected',
      baseContent: undefined,
      nextContent: undefined,
      error: undefined,
    }));
  }

  function applyAiEditProposal(messageId: string, proposal: AiEditProposal) {
    if (!activeAiConversation || proposal.status !== 'ready' || proposal.baseContent === undefined || proposal.nextContent === undefined) return;
    const conversationId = activeAiConversation.id;
    const baseContent = proposal.baseContent;
    const nextContent = proposal.nextContent;
    setConfirmDialog({
      title: '应用 AI 修改',
      message: `确认将已审阅的修改原子写入“${proposal.targetLabel}”？写入前会再次校验文件未发生变化。`,
      confirmLabel: '应用修改',
      onConfirm: async () => {
        updateAiProposal(conversationId, messageId, proposal.id, (current) => ({ ...current, status: 'applying', error: undefined }));
        try {
          if (proposal.isRemote) {
            if (!proposal.terminalId) throw new Error('目标终端已经不可用');
            await writeRemoteFileChecked(proposal.terminalId, proposal.targetSource, baseContent, nextContent);
          } else {
            await writeLocalFileChecked(proposal.targetSource, baseContent, nextContent);
          }
          setEditorTabs((current) => current.map((tab) => {
            const matchesTarget = tab.path === proposal.targetSource
              && tab.isRemote === Boolean(proposal.isRemote)
              && tab.terminalId === proposal.terminalId;
            if (!matchesTarget || tab.content !== baseContent || tab.originalContent !== baseContent) return tab;
            return { ...tab, content: nextContent, originalContent: nextContent };
          }));
          updateAiProposal(conversationId, messageId, proposal.id, (current) => ({
            ...current,
            status: 'applied',
            baseContent: undefined,
            nextContent: undefined,
            error: undefined,
          }));
          setStatusMessage(`AI 修改已应用：${proposal.targetSource}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stale = message.includes('AI_EDIT_STALE:');
          updateAiProposal(conversationId, messageId, proposal.id, (current) => ({
            ...current,
            status: stale ? 'stale' : 'error',
            baseContent: undefined,
            nextContent: undefined,
            error: message.replace('AI_EDIT_STALE:', ''),
          }));
        }
      },
    });
  }

  function regenerateAiMessage(assistantMessageId: string) {
    if (isAiGenerating || !activeAiConversation) return;
    const assistantIndex = activeAiConversation.messages.findIndex((message) => message.id === assistantMessageId);
    if (assistantIndex <= 0) return;
    const baseMessages = activeAiConversation.messages.slice(0, assistantIndex);
    const userMessage = [...baseMessages].reverse().find((message) => message.role === 'user');
    if (!userMessage) return;
    beginAiGeneration(activeAiConversation, baseMessages, userMessage);
  }

  function beginEditUserMessage(message: AiMessage) {
    if (isAiGenerating || message.role !== 'user') return;
    setEditingUserMessageId(message.id);
    setEditingUserMessageDraft(message.content);
  }

  function cancelEditUserMessage() {
    setEditingUserMessageId(null);
    setEditingUserMessageDraft('');
  }

  function autoResizeUserEditTextarea(element: HTMLTextAreaElement | null) {
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 18), 180)}px`;
  }

  /** 编辑用户消息后从该条重发（截断其后的回复，类似 Cursor） */
  function resubmitUserMessage(messageId: string) {
    if (isAiGenerating || !activeAiConversation) return;
    const content = editingUserMessageDraft.trim();
    if (!content) return;
    const messageIndex = activeAiConversation.messages.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) return;
    const original = activeAiConversation.messages[messageIndex];
    if (original.role !== 'user') return;
    const updatedUserMessage: AiMessage = {
      ...original,
      content,
      createdAt: new Date().toISOString(),
    };
    const baseMessages = [
      ...activeAiConversation.messages.slice(0, messageIndex),
      updatedUserMessage,
    ];
    cancelEditUserMessage();
    beginAiGeneration(activeAiConversation, baseMessages, updatedUserMessage);
  }

  function setActiveAiConversationMode(mode: AiConversationMode) {
    if (!activeAiConversation || isAiGenerating || activeAiConversation.mode === mode) return;
    updateAiConversation(activeAiConversation.id, (conversation) => ({
      ...conversation,
      mode,
      updatedAt: new Date().toISOString(),
    }));
  }

  function createNewAiConversation() {
    const conversation = createAiConversationState();
    setAiWorkspace((current) => ({
      conversations: [conversation, ...current.conversations],
      activeConversationId: conversation.id,
    }));
    setPendingAiContexts([]);
    setAiInput('');
    cancelEditUserMessage();
  }

  async function switchAiConversation(conversationId: string) {
    if (conversationId === activeAiConversation?.id) return;
    if (aiActiveRequestRef.current) await stopCurrentAiGeneration();
    setAiWorkspace((current) => ({ ...current, activeConversationId: conversationId }));
    setPendingAiContexts([]);
    cancelEditUserMessage();
  }

  function removeAiConversation(conversation: AiConversationState) {
    setConfirmDialog({
      title: '删除 AI 会话',
      message: `确定删除“${conversation.title}”吗？此操作不会删除任何项目文件。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        if (aiActiveRequestRef.current?.conversationId === conversation.id) {
          await stopCurrentAiGeneration();
        }
        const remaining = aiConversations.filter((item) => item.id !== conversation.id);
        const fallback = remaining[0] ?? createAiConversationState();
        setAiWorkspace({
          conversations: remaining.length > 0 ? remaining : [fallback],
          activeConversationId: fallback.id,
        });
        await deleteAiConversation(conversation.id);
      },
    });
  }

  function clearAiConversation() {
    if (!activeAiConversation) return;
    void stopCurrentAiGeneration();
    updateAiConversation(activeAiConversation.id, (conversation) => ({
      ...conversation,
      title: '新对话',
      updatedAt: new Date().toISOString(),
      messages: [],
    }));
    setPendingAiContexts([]);
    cancelEditUserMessage();
  }

  /** 清除全部 AI 会话：逐个删除后端会话（没有批量命令），本地重置为一个空白会话 */
  async function clearAllAiConversations() {
    if (aiConversations.length === 0) return;
    await stopCurrentAiGeneration();
    for (const conversation of aiConversations) {
      try {
        await deleteAiConversation(conversation.id);
      } catch (error) {
        setAiConversationError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const fallback = createAiConversationState();
    setAiWorkspace({
      conversations: [fallback],
      activeConversationId: fallback.id,
    });
    setPendingAiContexts([]);
    cancelEditUserMessage();
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
    sessionContentRef.current?.classList.add('is-resizing');

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = clampPanelWidth(((moveEvent.clientX - bounds.left) / bounds.width) * 100);
      resourcePanelWidthRef.current = nextWidth;
      // 拖动中只改 DOM，避免每帧整 App 重渲 + 终端 fit
      if (leftSidebarRef.current) {
        leftSidebarRef.current.style.width = `${nextWidth}%`;
      }
    };

    const stopResize = () => {
      sessionContentRef.current?.classList.remove('is-resizing');
      setResourcePanelWidth(resourcePanelWidthRef.current);
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
      targetRegion: null,
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

    let rightmostTabId: string | null = null;
    let rightmostEdge = Number.NEGATIVE_INFINITY;
    for (const [tabId, tabEl] of workspaceTabRefs.current) {
      const rect = tabEl.getBoundingClientRect();
      if (rect.right > rightmostEdge) {
        rightmostEdge = rect.right;
        rightmostTabId = tabId;
      }
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      return {
        targetTabId: tabId,
        reorderPlacement: clientX < rect.left + rect.width / 2 ? 'before' as const : 'after' as const,
      };
    }

    return rightmostTabId ? { targetTabId: rightmostTabId, reorderPlacement: 'after' as const } : null;
  }

  function getTabbarDropTargetPaneId(clientX: number, clientY: number): string | null {
    const hit = document.elementFromPoint(clientX, clientY);
    const tabbar = hit instanceof Element ? hit.closest('.terminal-pane-tabbar') : null;
    const pane = tabbar?.closest<HTMLElement>('.terminal-split-pane');
    return pane?.dataset.paneId ?? null;
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

  function updatePointerDragPreview(tabId: string, clientX: number, clientY: number, allowRootReorder = true) {
    const reorderHit = allowRootReorder ? getTabReorderHit(clientX, clientY) : null;
    if (reorderHit) {
      applyTerminalDragState({
        tabId,
        operation: 'reorder',
        isOverWorkspace: false,
        targetPaneId: null,
        targetTabId: reorderHit.targetTabId,
        targetRegion: null,
        side: null,
        reorderPlacement: reorderHit.reorderPlacement,
        ghostX: clientX,
        ghostY: clientY,
      });
      return;
    }

    const tabbarTargetPaneId = getTabbarDropTargetPaneId(clientX, clientY);
    if (tabbarTargetPaneId) {
      // Tabbar 是合并区；只有 pane 内容区域的边缘才产生 split。
      applyTerminalDragState({
        tabId,
        operation: 'replace',
        isOverWorkspace: true,
        targetPaneId: tabbarTargetPaneId,
        targetTabId: null,
        targetRegion: 'tabbar',
        side: null,
        reorderPlacement: null,
        ghostX: clientX,
        ghostY: clientY,
      });
      return;
    }

    // 顶层标签在标签栏内只做排序；拖出标签栏后继续进入 pane 命中，
    // 否则根工作区永远无法与另一个工作区建立分屏。

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

    const visitedPaneElements = new Set<HTMLElement>();
    for (const paneEl of terminalPaneRefs.current.values()) {
      if (visitedPaneElements.has(paneEl)) continue;
      visitedPaneElements.add(paneEl);

      const paneId = paneEl.dataset.paneId;
      if (!paneId) continue;
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
          targetRegion: 'pane',
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
        targetRegion: 'pane',
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
      targetRegion: null,
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

    const sourceTab = tabsRef.current.find((tab) => tab.id === draggingTabId && (tab.kind === 'terminal' || tab.kind === 'rdp'));
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
    const sourceTab = tabsRef.current.find((tab) => tab.id === draggingTabId && (tab.kind === 'terminal' || tab.kind === 'rdp'));
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
        (tab.kind === 'terminal' || tab.kind === 'rdp')
        && !tab.parentTabId
        && terminalLayoutContainsSplit(tab.layout ?? createDefaultTerminalLayout(tab.id), splitId),
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
        selectSessionWorkspaceTab(tabId);
        const now = performance.now();
        const previousClick = lastPaneTabClickRef.current;
        if (previousClick?.tabId === tabId && now - previousClick.at <= 350) {
          lastPaneTabClickRef.current = null;
          const sourceTab = tabsRef.current.find((item) => item.id === tabId);
          if (sourceTab && (sourceTab.kind === 'terminal' || sourceTab.kind === 'rdp')) {
            duplicatePaneConnection(sourceTab, sourceTab.activePaneId ?? sourceTab.id);
          }
        } else {
          lastPaneTabClickRef.current = { tabId, at: now };
        }
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
    if (terminalDragState.operation === 'replace') {
      return terminalDragState.targetRegion === 'tabbar' ? '' : ' drop-replace';
    }
    if (terminalDragState.operation !== 'split' || !terminalDragState.side) return '';
    return ` drop-${terminalDragState.side}`;
  }

  function getPaneDropPreview(paneId: string) {
    if (terminalDragState?.targetPaneId !== paneId) return null;
    if (terminalDragState.operation === 'replace') {
      return terminalDragState.targetRegion === 'tabbar'
        ? null
        : <div className="terminal-drop-preview replace" />;
    }
    if (terminalDragState.operation !== 'split' || !terminalDragState.side) return null;
    return <div className={`terminal-drop-preview ${terminalDragState.side}`} />;
  }

  function getPaneTabbarDropPreview(paneId: string) {
    if (
      terminalDragState?.targetPaneId !== paneId
      || terminalDragState.operation !== 'replace'
      || terminalDragState.targetRegion !== 'tabbar'
    ) {
      return null;
    }
    return <div className="terminal-drop-preview replace tabbar" />;
  }

  function clearTerminalDragPreview() {
    const current = terminalDragStateRef.current;
    if (!current) return;
    const next: TerminalDragState = {
      ...current,
      isOverWorkspace: false,
      targetPaneId: null,
      targetRegion: null,
      side: null,
    };
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
        {tab.kind === 'terminal' ? <TerminalSquare size={15} /> : tab.kind === 'rdp' ? <Monitor size={15} /> : <FolderOpen size={15} />}
        <span>{tab.title || tab.session.name}</span>
      </div>
    );
  }

  function startPaneTabPointerDrag(tabId: string, paneId: string, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    let activated = false;

    // pane 内 tab 的拖拽作用域就是该 pane 自身：pane 内互拖=重排，
    // 拖到 tabs 区域=合并，拖到 pane 内容边缘=自我分屏，拖出 pane=跨 pane 判定。
    const ownerTab = findTerminalWorkspaceOwner(tabsRef.current, paneId);
    const ownerTabId = ownerTab?.id ?? paneId;
    const samePaneTabIds = ownerTab
      ? findLeafTabGroup(ownerTab.layout ?? createDefaultTerminalLayout(ownerTab.id), paneId)
      : [paneId];
    const localDragScopeEl = terminalPaneRefs.current.get(paneId);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const distance = Math.hypot(dx, dy);
      if (!activated && distance < TERMINAL_TAB_DRAG_THRESHOLD) return;
      activated = true;

      if (localDragScopeEl) {
        const localDragScopeRect = localDragScopeEl.getBoundingClientRect();
        const outside = moveEvent.clientX < localDragScopeRect.left || moveEvent.clientX > localDragScopeRect.right
          || moveEvent.clientY < localDragScopeRect.top || moveEvent.clientY > localDragScopeRect.bottom;

        // pane 内部命中边缘=自我分屏；拖出 pane=进入全局 split/replace 判定。
        const tabbarTargetPaneId = getTabbarDropTargetPaneId(moveEvent.clientX, moveEvent.clientY);
        const inSplitEdge = !outside
          && !tabbarTargetPaneId
          && getDropSideFromRect(localDragScopeRect, moveEvent.clientX, moveEvent.clientY) !== null;

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
          updatePointerDragPreview(tabId, moveEvent.clientX, moveEvent.clientY, false);

          const globalMove = (ev: globalThis.PointerEvent) => {
            const c = terminalPointerDragRef.current;
            if (!c || c.tabId !== tabId) return;
            ev.preventDefault();
            updatePointerDragPreview(tabId, ev.clientX, ev.clientY, false);
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
        if (!samePaneTabIds.includes(refTabId)) continue;
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
      if (activated) {
        lastPaneTabClickRef.current = null;
        return;
      }

      focusTerminalPane(tabId);
      const now = performance.now();
      const previousClick = lastPaneTabClickRef.current;
      if (previousClick?.tabId === tabId && now - previousClick.at <= 350) {
        lastPaneTabClickRef.current = null;
        const sourceTab = tabsRef.current.find((item) => item.id === tabId);
        if (sourceTab) duplicatePaneConnection(sourceTab, tabId);
        return;
      }
      lastPaneTabClickRef.current = { tabId, at: now };
    };

    const handleBlur = () => handlePointerUp();

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handleBlur);
  }


  function renderTerminalLayoutNode(node: TerminalLayoutNode): ReactNode {
    if (node.type === 'split') {
      return (
        <div className={`terminal-split terminal-split-${node.direction}`}>
          <div className="terminal-split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
            {renderTerminalLayoutNode(node.first)}
          </div>
          <div
            className="terminal-split-divider"
            onPointerDown={(event) => startSplitDividerDrag(node.id, node.direction, node.ratio, event)}
          />
          <div className="terminal-split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
            {renderTerminalLayoutNode(node.second)}
          </div>
        </div>
      );
    }

    return renderPaneLeaf(node);
  }

  function isWorkspaceChipActive(tabId: string): boolean {
    // Workspace root 只有在它本身是当前显示 pane，且编辑器未覆盖终端时才选中。
    return !showEditor && activeTabId === tabId && activePaneId === tabId;
  }

  function isPaneTabActive(tabId: string, paneTabId: string): boolean {
    // pane tab 只代表当前实际显示的终端；编辑器打开时不保留终端 active。
    return !showEditor && activeTabId !== null && activePaneId === paneTabId && tabId === paneTabId;
  }

  // 渲染 pane tabbar 的单个 terminal/RDP tab。
  // paneTabId 是该 pane 当前激活 tab，同时作为拖拽时的 pane 身份。
  function renderPaneTab(tab: WorkspaceTab, paneTabId: string): ReactNode {
    const active = isPaneTabActive(tab.id, paneTabId);
    return (
      <div
        key={tab.id}
        ref={(el) => {
          if (el) paneTabElRefs.current.set(tab.id, el);
          else paneTabElRefs.current.delete(tab.id);
        }}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        draggable={false}
        className={active ? 'terminal-pane-tab active' : 'terminal-pane-tab'}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.stopPropagation();
          startPaneTabPointerDrag(tab.id, paneTabId, event);
        }}
      >
        {tab.kind === 'rdp' ? <Monitor size={15} /> : <TerminalSquare size={15} />}
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
    );
  }

  // 渲染 pane tabbar 的单个 workspace chip（来自原顶栏：跨 workspace 切换 + 顶层拖拽排序）。
  function renderWorkspaceChip(tab: WorkspaceTab): ReactNode {
    return (
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
        aria-selected={isWorkspaceChipActive(tab.id)}
        tabIndex={0}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (tab.kind === 'terminal' || tab.kind === 'rdp') startTabPointerDrag(tab.id, event);
        }}
        onClick={() => {
          if (tab.kind !== 'terminal' && tab.kind !== 'rdp') selectSessionWorkspaceTab(tab.id);
        }}
        className={`${isWorkspaceChipActive(tab.id) ? 'workspace-tab active' : 'workspace-tab'}${getWorkspaceTabDropClass(tab.id)}`}
      >
        {tab.kind === 'terminal' ? <TerminalSquare size={15} /> : tab.kind === 'rdp' ? <Monitor size={15} /> : <FolderOpen size={15} />}
        <span className={`workspace-tab-state ${tab.status}`} />
        <span>{tab.title || tab.session.name}</span>
        <button
          className="workspace-tab-close"
          title="关闭 workspace"
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  // 渲染 pane tabbar 的单个编辑器 tab（来自原顶栏，未保存标记保留）。
  function renderEditorPaneTab(tab: EditorTab): ReactNode {
    const dirty = tab.content !== tab.originalContent;
    const active = showEditor && activeEditorTabId === tab.id;
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        draggable={false}
        className={`workspace-tab is-editor${active ? ' active' : ''}`}
        title={tab.isUntitled ? '未保存的空白文件' : tab.path}
        onDragStart={(event) => event.preventDefault()}
        onClick={() => selectEditorWorkspaceTab(tab.id)}
      >
        <FileText size={15} />
        <span>{editorTabLabel(tab, editorTabs)}</span>
        {dirty && <span className="workspace-tab-dirty" aria-hidden>•</span>}
        <button
          className="workspace-tab-close"
          onClick={(event) => {
            event.stopPropagation();
            closeEditorTab(tab.id);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  // 所有 tab 类型在同一个 tablist 中平铺；只保留一个 tab 容器和一个新建入口。
  function renderWorkspaceTabItems(): ReactNode {
    return tabs
      .filter((tab) => !tab.parentTabId && tab.session.id !== localSession.id)
      .map(renderWorkspaceChip);
  }

  function renderEditorTabItems(paneTabId?: string): ReactNode {
    // 主区独立标签栏（无 paneTabId）显示全部文件标签；
    // pane 内只显示归属该 pane 的文件标签（无归属的回退到当前活动 pane）
    const list = paneTabId
      ? editorTabs.filter((t) => (t.hostPaneId ?? activePaneId) === paneTabId)
      : editorTabs;
    return list.map(renderEditorPaneTab);
  }

  function renderPaneTabItems(paneTabId: string, paneTabs: WorkspaceTab[]): ReactNode {
    return paneTabs.map((tab) => renderPaneTab(tab, paneTabId));
  }

  function renderUnifiedPaneTabbar(
    paneTabId: string | undefined,
    paneTabs: WorkspaceTab[],
    showWorkspaceTabs: boolean,
    targetPaneId?: string,
  ): ReactNode {
    return (
      <div className="terminal-pane-tabs" onWheel={scrollHorizontallyOnWheel}>
        <div
          ref={showWorkspaceTabs ? workspaceTabsRef : undefined}
          className="terminal-pane-tab-group terminal-pane-tab-group-unified"
          role="tablist"
          aria-label="标签"
        >
          {showWorkspaceTabs && renderWorkspaceTabItems()}
          {/* 文件标签按归属 pane 过滤（见 renderEditorTabItems）：谁的标签栏显示谁打开的文件，
              常驻显示、不随编辑器视图开关（showEditor）或焦点切换消失 */}
          {renderEditorTabItems(paneTabId)}
          {paneTabId && renderPaneTabItems(paneTabId, paneTabs)}
        </div>
        {renderPaneAddButton(targetPaneId)}
      </div>
    );
  }

  function renderPaneAddButton(targetPaneId?: string): ReactNode {
    return (
      <button
        className="workspace-tab-add"
        title="新建连接"
        onClick={(event) => {
          event.stopPropagation();
          openNewConnectionTab(targetPaneId);
        }}
      >
        <Plus size={16} />
      </button>
    );
  }

  // Pane 叶子渲染：从 renderTerminalLayoutNode 拆出的接缝，未来按 tab.kind 分发
  // （terminal→xterm-host / rdp→RdpView），是 RDP 进分屏体系的落点。
  function renderPaneLeaf(
    node: Extract<TerminalLayoutNode, { type: 'leaf' }>,
  ): ReactNode {
    const paneTabIds = getLeafTabIds(node);
    const workspaceOwnerId = findTerminalWorkspaceOwner(tabs, node.tabId)?.id ?? null;
    // 内容区必须包含 leaf 内的全部终端实例；只有标签栏排除 workspace root，避免视觉重复。
    const paneContentTabs = paneTabIds
      .map((tabId) => tabs.find((tab) => tab.id === tabId && (tab.kind === 'terminal' || tab.kind === 'rdp')))
      .filter((tab): tab is WorkspaceTab => Boolean(tab));
    const paneTabs = paneContentTabs.filter((tab) => tab.id !== workspaceOwnerId);
    const paneTab = tabs.find((tab) => tab.id === node.tabId && (tab.kind === 'terminal' || tab.kind === 'rdp')) ?? paneContentTabs[0];
    if (!paneTab) return null;
    const isActivePane = node.tabId === activePaneId;
    const isWorkspacePane = activeTab ? paneTabIds.includes(activeTab.id) : false;
    // 编辑器打开时，当前活动 pane 仍是编辑器标签栏的承载 pane。
    // 不再只依赖 workspace root tab，避免本地编辑器切换后 root 判断短暂失配导致 tabs 消失。
    const showWorkspaceChips = isWorkspacePane || (showEditor && editorDisplayPaneId === node.tabId);

    return (
      <section
        data-pane-id={node.tabId}
        ref={(el) => {
          if (el) {
            terminalPaneRefs.current.set(node.tabId, el);
            for (const tabId of paneTabIds) terminalPaneRefs.current.set(tabId, el);
          } else {
            for (const tabId of paneTabIds) terminalPaneRefs.current.delete(tabId);
          }
        }}
        className={`${isActivePane ? 'terminal-split-pane active' : 'terminal-split-pane'} has-tabbar${showEditor && showWorkspaceChips ? ' is-editor' : ''}${getPaneDropClass(node.tabId)}`}
        onMouseDown={() => {
          if (showEditor) {
            // 编辑器视图下点其它 pane：焦点切过去输入，编辑器留在宿主 pane
            if (node.tabId !== editorDisplayPaneId) focusPaneKeepEditor(node.tabId);
            return;
          }
          focusTerminalPane(node.tabId);
        }}
      >
        {getPaneDropPreview(node.tabId)}
        <div className="terminal-pane-tabbar">
          {getPaneTabbarDropPreview(node.tabId)}
          {/* 连接标签只挂在 workspace 根 pane：编辑器宿主 pane 的标签栏只放文件标签 + 自己的终端 tab，
              否则分屏时每个 pane 都会重复渲染全部服务器连接标签 */}
          {renderUnifiedPaneTabbar(node.tabId, paneTabs, isWorkspacePane, node.tabId)}
        </div>
        {paneTab.kind === 'rdp' ? (
          <div className="rdp-focus-card">
            <RdpView
              key={paneTab.id}
              sessionId={paneTab.session.id}
              terminalId={paneTab.terminalId}
            />
          </div>
        ) : paneTab.status === 'failed' && !showEditor ? (
          <div className="terminal-connection-state is-error">
            <Server size={24} />
            <h2>连接失败</h2>
            <p>{paneTab.session.username}@{paneTab.session.host}:{paneTab.session.port}</p>
            <span>{paneTab.statusMessage || '终端没有进入可用状态。'}</span>
          </div>
        ) : (
          <>
            {paneContentTabs.map((tab) => (
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
                onContextMenu={(event) => handleTerminalContextMenu(event, tab.id)}
                onPasteCapture={(event) => handleTerminalPasteEvent(event, tab.id)}
              />
            ))}
            {(paneTab.status === 'connecting' || paneTab.status === 'reconnecting') && !showEditor && (
              <div className="terminal-connection-overlay">
                <RefreshCw size={18} className="spin" />
                <span>{paneTab.statusMessage || '等待终端就绪...'}</span>
              </div>
            )}
            {/* 编辑器只在当前活动 pane 渲染：分屏时若多个 pane 同时挂 EditorPanel，
                同一文件会在每个 pane 各显示一份（model 按稳定 key 全局共享） */}
            {showEditor && editorDisplayPaneId === node.tabId && (
              <div className="terminal-pane-editor-host">
                <EditorPanel
                  tabs={editorTabs}
                  activeTabId={activeEditorTabId}
                  onSelectTab={selectEditorWorkspaceTab}
                  onCloseTab={closeEditorTab}
                  onSave={saveEditorFile}
                  onContentChange={updateEditorContent}
                  onCreateUntitled={createUntitledEditorTab}
                  showTabBar={false}
                  visible={showEditor}
                />
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <main className="ssh-workbench" onDragOver={handleGlobalDragOver} onDrop={handleGlobalDrop}>
      <TopMenubar
        sessionName={topStatusName}
        sessionUser={topStatusUser}
        sessionHost={topStatusHost}
        onOpenConnectionCreate={() => {
          void openConnectionWindow('create');
        }}
        onOpenConnectionManage={() => {
          void openConnectionWindow('manage');
        }}
        onOpenAiSettings={() => openAiSettings()}
        onSetLeftActivity={(panel) => setLeftActivity(panel)}
      />

      <section ref={sessionContentRef} className="session-content">
        {openingConnection && (
          <div className="connection-opening-overlay">
            <RefreshCw size={18} className="spin" />
            <span>
              正在打开 {openingConnection.session.name || '连接'}...{' '}
              <span ref={openingSecondsRef}>0</span>s
            </span>
          </div>
        )}
        <div
          ref={leftSidebarRef}
          className={`left-sidebar${leftActivity ? '' : ' collapsed'}`}
          style={leftActivity ? { width: `${resourcePanelWidth}%` } : { width: '48px' }}
        >
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
            <button
              className={`activity-bar-icon${leftActivity === 'ai' ? ' active' : ''}`}
              onClick={() => toggleLeftActivity('ai')}
              title="PandaTerm AI"
            >
              <Bot size={20} />
            </button>
          </div>
          {leftActivity === 'files' && (
        <aside
          className={`file-panel${isDragOver ? ' is-drag-over' : ''}`}
          style={{ gridTemplateRows: '42px auto minmax(0, 1fr)' }}
          onDragEnter={handleDragEnter}
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
                <div
                  className="file-list-body"
                  tabIndex={0}
                  onKeyDown={handleResourceKeyDown}
                  onContextMenu={handleBlankContextMenu}
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    clearPendingInlineRename();
                    lastPlainFileClickRef.current = null;
                    setSelectedFiles(new Set());
                    setLastClickedIndex(-1);
                  }}
                >
                  {!isLoadingFiles && !fileListError && visibleFiles.map((file, index) => (
                    <div
                      key={file.path}
                      role="button"
                      tabIndex={-1}
                      className={`${selectedFiles.has(file.name) ? 'file-item selected' : 'file-item'}${clipboard?.operation === 'cut' && clipboard.paths.includes(file.path) ? ' is-cut' : ''}`}
                      onClick={(e) => handleFileClick(e, file, index)}
                      onDoubleClick={() => handleFileDoubleClick(file)}
                      onContextMenu={(e) => handleFileContextMenu(e, file)}
                    >
                      <span className="file-name">
                        <VscodeFileIcon filename={file.name} isDirectory={file.type === 'directory'} />
                        {inlineRename?.path === file.path ? (
                          <input
                            ref={inlineRenameInputRef}
                            className="file-inline-rename-input"
                            value={inlineRename.value}
                            disabled={inlineRename.submitting}
                            aria-label={`重命名 ${file.name}`}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onChange={(event) => setInlineRename((current) => current
                              ? { ...current, value: event.target.value }
                              : null)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void submitInlineRename();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelInlineRename();
                              }
                            }}
                            onBlur={() => void submitInlineRename()}
                          />
                        ) : (
                          <span className="file-name-text">{file.name}</span>
                        )}
                      </span>
                      <span>{file.size}</span>
                      <span>{file.type === 'directory' ? '文件夹' : '文件'}</span>
                      <span>{file.modifiedTime}</span>
                    </div>
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
        {leftActivity === 'ai' && (
          <div className="side-panel ai-panel">
            <div className="side-panel-header ai-panel-header">
              <span className="ai-panel-title"><Sparkles size={15} />PandaTerm AI</span>
              <div className="ai-panel-actions">
                <button
                  type="button"
                  className="ai-header-button"
                  title="新建对话"
                  disabled={isAiGenerating}
                  onClick={createNewAiConversation}
                >
                  <MessageSquarePlus size={14} />
                </button>
                <button
                  type="button"
                  className="ai-header-button"
                  title="AI 供应商设置"
                  onClick={() => openAiSettings()}
                >
                  <Settings size={14} />
                </button>
                <button
                  type="button"
                  className="ai-header-button"
                  title="清空当前对话"
                  onClick={clearAiConversation}
                  disabled={aiMessages.length === 0}
                >
                  <Eraser size={14} />
                </button>
                <button
                  type="button"
                  className="ai-header-button"
                  title="清除全部对话"
                  onClick={() => {
                    setConfirmDialog({
                      title: '清除全部 AI 对话',
                      message: `将删除全部 ${aiConversations.length} 个会话及其聊天记录，此操作不可恢复。确定清除吗？`,
                      confirmLabel: '清除全部',
                      danger: true,
                      onConfirm: () => { void clearAllAiConversations(); },
                    });
                  }}
                  disabled={!aiConversations.some((conversation) => conversation.messages.length > 0)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Cursor 风格：会话 tabs，hover 显示删除 */}
            <div className="ai-session-tabs" role="tablist" aria-label="AI 会话" onWheel={scrollHorizontallyOnWheel}>
              {aiConversations.map((conversation) => {
                const isActive = conversation.id === activeAiConversation?.id;
                return (
                  <div
                    key={conversation.id}
                    role="tab"
                    tabIndex={0}
                    aria-selected={isActive}
                    className={isActive ? 'ai-session-tab active' : 'ai-session-tab'}
                    title={conversation.title}
                    onClick={() => void switchAiConversation(conversation.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void switchAiConversation(conversation.id);
                      }
                    }}
                  >
                    <span className="ai-session-tab-title">{conversation.title || '新对话'}</span>
                    <button
                      type="button"
                      className="ai-session-tab-close"
                      title="删除会话"
                      aria-label={`删除 ${conversation.title || '新对话'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeAiConversation(conversation);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>

            {aiConversationError && <div className="ai-conversation-error">{aiConversationError}</div>}

            <div ref={aiMessageListRef} className="ai-message-list">
              {aiMessages.length === 0 ? (
                <div className="ai-empty-state">
                  <div className="ai-empty-icon"><Bot size={24} /></div>
                  <strong>可以开始工作了</strong>
                  <span>输入问题，或使用 @ 引用终端、选中文本和项目文件。</span>
                  <div className="ai-empty-suggestions">
                    {AI_EMPTY_SUGGESTIONS.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="ai-empty-chip"
                        disabled={isAiGenerating}
                        onClick={() => setAiInput(item.prompt)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : aiMessages.map((message) => {
                const isUser = message.role === 'user';
                const isEditingUser = isUser && editingUserMessageId === message.id;
                const isContinuation = isUser && isAiAgentContinuationMessage(message);
                if (isContinuation) return null;
                return (
                <article key={message.id} className={`ai-message ${message.role} ${message.status}${isEditingUser ? ' editing' : ''}`}>
                  <div className="ai-message-body">
                    {(message.status === 'cancelled' || message.status === 'error') && (
                      <div className="ai-message-status">
                        {message.status === 'cancelled' && <em>已停止</em>}
                        {message.status === 'error' && <em>失败</em>}
                      </div>
                    )}
                    {message.contexts.length > 0 && (
                      <div className="ai-message-contexts">
                        {message.contexts.map((context, index) => (
                          <span key={`${message.id}-${context.kind}-${index}`} title={context.source ?? context.label}>
                            <Paperclip size={11} />{context.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {isUser ? (
                      isEditingUser ? (
                        <div className="ai-user-bubble is-editing">
                          <textarea
                            autoFocus
                            value={editingUserMessageDraft}
                            rows={1}
                            aria-label="编辑消息"
                            ref={(element) => autoResizeUserEditTextarea(element)}
                            onChange={(event) => {
                              setEditingUserMessageDraft(event.target.value);
                              autoResizeUserEditTextarea(event.target);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelEditUserMessage();
                              }
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                resubmitUserMessage(message.id);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="ai-user-resubmit"
                            title="重新发送"
                            disabled={isAiGenerating || !editingUserMessageDraft.trim()}
                            onClick={() => resubmitUserMessage(message.id)}
                          >
                            <CornerDownLeft size={14} />
                          </button>
                        </div>
                      ) : (
                        <div
                          className="ai-user-bubble"
                          role="button"
                          tabIndex={0}
                          title={isAiGenerating ? undefined : '点击编辑'}
                          onClick={() => beginEditUserMessage(message)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              beginEditUserMessage(message);
                            }
                          }}
                        >
                          <div className="ai-message-content">{message.content}</div>
                          <button
                            type="button"
                            className="ai-user-resubmit"
                            title="编辑并重新发送"
                            disabled={isAiGenerating}
                            onClick={(event) => {
                              event.stopPropagation();
                              beginEditUserMessage(message);
                            }}
                          >
                            <CornerDownLeft size={14} />
                          </button>
                        </div>
                      )
                    ) : message.content ? (
                      <div className="ai-message-content">
                        <AiMarkdown content={message.content} />
                      </div>
                    ) : message.status === 'streaming' ? (
                      <div className="ai-typing" aria-label="正在生成"><i /><i /><i /></div>
                    ) : null}
                    {message.proposals.map((proposal) => {
                      const delta = summarizeEditDelta(proposal);
                      return (
                        <section className={`ai-edit-proposal ${proposal.status}`} key={proposal.id}>
                          <div className="ai-edit-proposal-header">
                            <div>
                              <strong>{proposal.summary}</strong>
                              <span title={proposal.targetSource}>{proposal.targetLabel}</span>
                            </div>
                            <span className="ai-edit-delta"><b>+{delta.added}</b><i>-{delta.removed}</i></span>
                          </div>
                          {proposal.status === 'ready' && (
                            <div className="ai-edit-diff">
                              {proposal.edits.map((edit, index) => (
                                <div key={`${proposal.id}-edit-${index}`}>
                                  <span>修改 {index + 1}</span>
                                  <pre className="removed">{edit.search.slice(0, 2000)}</pre>
                                  <pre className="added">{edit.replace.slice(0, 2000) || '（删除）'}</pre>
                                </div>
                              ))}
                            </div>
                          )}
                          {proposal.error && <div className="ai-edit-error">{proposal.error}</div>}
                          <div className="ai-edit-actions">
                            {['proposed', 'error', 'stale'].includes(proposal.status) && (
                              <button type="button" onClick={() => reviewAiEditProposal(message.id, proposal)}>
                                {proposal.status === 'proposed' ? '授权读取并审阅' : '重新读取'}
                              </button>
                            )}
                            {proposal.status === 'ready' && (
                              <button type="button" className="primary" onClick={() => applyAiEditProposal(message.id, proposal)}>
                                应用修改
                              </button>
                            )}
                            {!['applied', 'rejected', 'applying', 'reading'].includes(proposal.status) && (
                              <button type="button" onClick={() => rejectAiEditProposal(message.id, proposal)}>拒绝</button>
                            )}
                            {proposal.status === 'reading' && <span>正在读取并校验…</span>}
                            {proposal.status === 'applying' && <span>正在校验并写入…</span>}
                            {proposal.status === 'applied' && (
                              <>
                                <span className="success">已应用</span>
                                {activeAiConversation?.mode === 'agent' && !proposal.continued && canContinueAiAgent(activeAiConversation) && (
                                  <button type="button" onClick={() => continueAgentAfterEdit(message.id, proposal)}>继续 Agent</button>
                                )}
                                {activeAiConversation?.mode === 'agent' && !proposal.continued && !canContinueAiAgent(activeAiConversation) && (
                                  <span>已达到单次任务 {AI_AGENT_MAX_CONTINUATIONS} 步上限</span>
                                )}
                                {proposal.continued && <span>结果已发送</span>}
                              </>
                            )}
                            {proposal.status === 'rejected' && <span>已拒绝</span>}
                            {proposal.status === 'stale' && <span>文件已变化</span>}
                          </div>
                        </section>
                      );
                    })}
                    {message.terminalActions.map((action) => (
                      <section className={`ai-terminal-action ${action.status}`} key={action.id}>
                        <div className="ai-terminal-action-header">
                          <div>
                            <strong>{action.summary}</strong>
                            <span>{action.contextLabel} · {action.isRemote ? '远程' : '本地'} · {Math.round(action.timeoutMs / 1000)}s</span>
                          </div>
                          {isHighRiskTerminalCommand(action.command) && <em>高风险</em>}
                          {aiAutoRunEnabled && action.status === 'proposed' && !isHighRiskTerminalCommand(action.command) && (
                            <em className="ai-action-auto">自动执行</em>
                          )}
                        </div>
                        <pre className="ai-terminal-command">{action.command}</pre>
                        {action.output !== undefined && action.status === 'completed' && (
                          <pre className="ai-terminal-output">{action.output || '（无输出）'}</pre>
                        )}
                        {action.error && <div className="ai-terminal-error">{action.error}</div>}
                        <div className="ai-terminal-actions">
                          {['proposed', 'timeout', 'error'].includes(action.status) && (
                            <button
                              type="button"
                              className={isHighRiskTerminalCommand(action.command) ? 'danger' : 'primary'}
                              onClick={() => {
                                if (!activeAiConversation) return;
                                void runAiTerminalAction(activeAiConversation.id, message.id, action);
                              }}
                            >
                              {action.status === 'proposed' ? '授权并执行' : '重新执行'}
                            </button>
                          )}
                          {!['running', 'completed', 'rejected'].includes(action.status) && (
                            <button type="button" onClick={() => rejectAiTerminalAction(message.id, action)}>拒绝</button>
                          )}
                          {action.status === 'running' && <span>正在隔离执行…</span>}
                          {action.status === 'completed' && (
                            <>
                              {activeAiConversation?.mode === 'agent' && !action.continued && canContinueAiAgent(activeAiConversation) && !isAiGenerating && (
                                <button
                                  type="button"
                                  onClick={() => continueAgentAfterTerminal(activeAiConversation.id, message.id, action)}
                                >继续 Agent</button>
                              )}
                              {activeAiConversation?.mode === 'agent' && !action.continued && !canContinueAiAgent(activeAiConversation) && (
                                <span>已达到单次任务 {AI_AGENT_MAX_CONTINUATIONS} 步上限，结果未回传</span>
                              )}
                            </>
                          )}
                          {action.status === 'rejected' && <span>已拒绝</span>}
                          {action.status === 'timeout' && <span>执行超时</span>}
                        </div>
                      </section>
                    ))}
                    {message.mcpActions.map((action) => (
                      <section className={`ai-terminal-action ai-mcp-action ${action.status}`} key={action.id}>
                        <div className="ai-terminal-action-header">
                          <div>
                            <strong>{action.summary}</strong>
                            <span>MCP · {action.serverId}/{action.toolName}</span>
                          </div>
                          {aiAutoRunEnabled && action.status === 'proposed' && (
                            <em className="ai-action-auto">自动执行</em>
                          )}
                        </div>
                        <pre className="ai-terminal-command">{JSON.stringify(action.arguments ?? {}, null, 2)}</pre>
                        {action.content !== undefined && action.status === 'completed' && (
                          <pre className="ai-terminal-output">{action.content || '（无输出）'}</pre>
                        )}
                        {action.error && <div className="ai-terminal-error">{action.error}</div>}
                        <div className="ai-terminal-actions">
                          {['proposed', 'error'].includes(action.status) && (
                            <button
                              type="button"
                              className="primary"
                              onClick={() => {
                                if (!activeAiConversation) return;
                                void runAiMcpAction(activeAiConversation.id, message.id, action);
                              }}
                            >
                              {action.status === 'proposed' ? '授权并调用' : '重新调用'}
                            </button>
                          )}
                          {!['running', 'completed', 'rejected'].includes(action.status) && (
                            <button type="button" onClick={() => rejectAiMcpAction(message.id, action)}>拒绝</button>
                          )}
                          {action.status === 'running' && <span>正在调用 MCP…</span>}
                          {action.status === 'completed' && (
                            <>
                              <span className="success">已完成{action.isError ? '（工具报错）' : ''}</span>
                              {activeAiConversation?.mode === 'agent' && !action.continued && canContinueAiAgent(activeAiConversation) && !isAiGenerating && (
                                <button
                                  type="button"
                                  onClick={() => continueAgentAfterMcp(activeAiConversation.id, message.id, action)}
                                >继续 Agent</button>
                              )}
                              {activeAiConversation?.mode === 'agent' && !action.continued && !canContinueAiAgent(activeAiConversation) && (
                                <span>已达到单次任务 {AI_AGENT_MAX_CONTINUATIONS} 步上限，结果未回传</span>
                              )}
                            </>
                          )}
                          {action.status === 'rejected' && <span>已拒绝</span>}
                        </div>
                      </section>
                    ))}
                  </div>
                </article>
                );
              })}
              <div ref={aiMessagesEndRef} />
            </div>

            <div className="ai-composer">
              <div className="ai-context-toolbar">
                <button
                  type="button"
                  className="ai-context-add"
                  title="添加上下文"
                  onClick={() => setIsAiMentionOpen((current) => !current)}
                >
                  <Paperclip size={12} />@
                </button>
                {pendingAiContexts.map((context, index) => (
                  <span className="ai-pending-context" key={`${context.kind}-${context.source ?? context.label}-${index}`}>
                    {context.label}
                    <button
                      type="button"
                      title="移除上下文"
                      onClick={() => setPendingAiContexts((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {pendingAiContexts.length === 0 && <span className="ai-context-hint">@ 添加上下文，每次读取都会确认</span>}
              </div>
              {isAiMentionOpen && (
                <div className="ai-mention-menu">
                  <strong>添加上下文</strong>
                  <button type="button" disabled={!activePaneTab} onClick={() => requestAiContext('terminal')}>
                    <TerminalSquare size={13} /><span>当前终端</span>
                  </button>
                  <button
                    type="button"
                    disabled={!activePaneTab || !terminalsRef.current.get(activePaneTab.id)?.getSelection().trim()}
                    onClick={() => requestAiContext('selection')}
                  >
                    <Clipboard size={13} /><span>终端选中文本</span>
                  </button>
                  <button type="button" disabled={!activeEditorTabId} onClick={() => requestAiContext('file')}>
                    <FileText size={13} /><span>当前编辑器文件</span>
                  </button>
                  {resourceFiles.filter((file) => file.type === 'file').slice(0, 8).map((file) => (
                    <button type="button" key={file.path} onClick={() => requestAiContext('file', file)}>
                      <File size={13} /><span>{file.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {aiMessageQueue.length > 0 && (
                <div className="ai-message-queue" aria-label="待发送队列">
                  {aiMessageQueue.map((item) => (
                    <div key={item.id} className="ai-queue-item">
                      <em>排队</em>
                      <span title={item.content}>{item.content}</span>
                      <button
                        type="button"
                        aria-label="移除排队消息"
                        onClick={() => setAiMessageQueue((queue) => queue.filter((row) => row.id !== item.id))}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="ai-input-shell">
                <textarea
                  ref={aiInputRef}
                  value={aiInput}
                  rows={1}
                  placeholder="向 PandaTerm AI 提问，输入 @ 添加上下文"
                  onChange={(event) => {
                    const el = event.target;
                    const value = el.value;
                    setAiInput(value);
                    setIsAiMentionOpen(/(^|\s)@[^\s@]*$/.test(value));
                    // 先收再撑，才能正确收缩/增高
                    el.style.height = 'auto';
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setIsAiMentionOpen(false);
                    if (event.key === 'Enter' && !event.shiftKey && !isAiMentionOpen) {
                      event.preventDefault();
                      void submitAiMessage();
                    }
                  }}
                />
                <div className="ai-input-footer">
                  <div className="ai-input-footer-meta">
                    {(() => {
                      const currentMode = activeAiConversation?.mode ?? 'agent';
                      const currentModeOption = AI_MODE_OPTIONS.find((item) => item.value === currentMode);
                      const modelOptions = aiProviderConfig
                        ? resolveAiChatModelOptions(aiProviderConfig)
                        : [];
                      const currentEffort = normalizeAiReasoningEffort(aiProviderConfig?.reasoning_effort);
                      const currentEffortOption = AI_REASONING_EFFORT_OPTIONS.find((item) => item.value === currentEffort);
                      const autoTerminalContext = currentMode === 'agent'
                        && activePaneTab
                        && activePaneTab.kind === 'terminal'
                        && activePaneTab.status === 'connected'
                        && !pendingAiContexts.some(({ kind }) => kind === 'terminal' || kind === 'selection')
                        ? {
                          kind: 'terminal' as const,
                          label: `${activePaneTab.title || activePaneTab.session.name}（仅终端目标，未读取输出）`,
                          source: activePaneTab.id,
                          preview: `terminal_target_only: true\nstatus: ${activePaneTab.status}\noutput_authorized: false`,
                          isRemote: !isLocalResourceTab(activePaneTab),
                          terminalId: activePaneTab.terminalId,
                        }
                        : null;
                      const contextUsage = estimateAiContextUsage({
                        conversation: activeAiConversation,
                        draft: aiInput,
                        pendingContexts: pendingAiContexts,
                        autoTerminalContext,
                      });
                      const contextRingRadius = 7;
                      const contextRingCircumference = 2 * Math.PI * contextRingRadius;
                      const contextRingOffset = contextRingCircumference * (1 - contextUsage.percent / 100);
                      const contextTone = contextUsage.percent >= 90
                        ? 'danger'
                        : contextUsage.percent >= 70
                          ? 'warn'
                          : 'ok';
                      const toggleComposerMenu = (menu: 'mode' | 'model' | 'effort' | 'context', trigger: HTMLButtonElement) => {
                        if (aiComposerMenu === menu) {
                          setAiComposerMenu(null);
                          setAiComposerMenuAnchor(null);
                          return;
                        }
                        setAiComposerMenuAnchor(measureFloatingMenuAnchor(trigger));
                        setAiComposerMenu(menu);
                      };
                      const closeComposerMenu = () => {
                        setAiComposerMenu(null);
                        setAiComposerMenuAnchor(null);
                      };
                      const providerAccounts = aiProviderConfig?.accounts?.length
                        ? aiProviderConfig.accounts
                        : (aiProviderConfig
                          ? [{
                            id: aiProviderConfig.account_id || aiProviderConfig.active_account_id || 'default',
                            name: aiProviderConfig.account_name || '默认',
                            base_url: aiProviderConfig.base_url,
                            model: aiProviderConfig.model,
                            api_format: String(aiProviderConfig.api_format || 'openai'),
                            api_key_configured: aiProviderConfig.api_key_configured,
                          }]
                          : []);
                      const activeProviderId = (aiProviderConfig?.account_id || aiProviderConfig?.active_account_id || '').trim()
                        || providerAccounts[0]?.id
                        || '';
                      const activeProviderName = (aiProviderConfig?.account_name || '').trim()
                        || providerAccounts.find((item) => item.id === activeProviderId)?.name
                        || providerAccounts[0]?.name
                        || '供应商';
                      const composerMenuMinWidth = aiComposerMenu === 'model'
                        ? 420
                        : aiComposerMenu === 'effort'
                          ? 200
                          : aiComposerMenu === 'context'
                            ? 240
                            : 188;
                      const composerPopoverStyle = aiComposerMenuAnchor
                        ? {
                            left: clampFloatingMenuLeft(aiComposerMenuAnchor.left, composerMenuMinWidth),
                            bottom: Math.max(8, window.innerHeight - aiComposerMenuAnchor.top + 6),
                            minWidth: Math.max(aiComposerMenuAnchor.width + 24, composerMenuMinWidth),
                          }
                        : undefined;
                      return (
                        <>
                          <div className="ai-composer-menu">
                            <button
                              type="button"
                              className={`ai-composer-trigger${aiComposerMenu === 'mode' ? ' open' : ''}`}
                              aria-label="AI 交互模式"
                              aria-haspopup="listbox"
                              aria-expanded={aiComposerMenu === 'mode'}
                              title={currentModeOption?.hint}
                              disabled={isAiGenerating}
                              onClick={(event) => toggleComposerMenu('mode', event.currentTarget)}
                            >
                              {currentMode === 'agent'
                                ? <Sparkles size={12} className="ai-composer-trigger-icon" aria-hidden />
                                : <MessageSquarePlus size={12} className="ai-composer-trigger-icon" aria-hidden />}
                              <span>{currentModeOption?.label ?? 'Agent'}</span>
                              <ChevronDown size={12} aria-hidden />
                            </button>
                            {aiComposerMenu === 'mode' && aiComposerMenuAnchor && createPortal(
                              <div
                                className="ai-composer-popover"
                                role="listbox"
                                aria-label="选择交互模式"
                                style={composerPopoverStyle}
                              >
                                {AI_MODE_OPTIONS.map((option) => {
                                  const selected = option.value === currentMode;
                                  return (
                                    <button
                                      type="button"
                                      key={option.value}
                                      role="option"
                                      aria-selected={selected}
                                      className={selected ? 'active' : undefined}
                                      onClick={() => {
                                        setActiveAiConversationMode(option.value);
                                        closeComposerMenu();
                                      }}
                                    >
                                      <span className="ai-composer-option-leading">
                                        {option.value === 'agent'
                                          ? <Sparkles size={13} aria-hidden />
                                          : <MessageSquarePlus size={13} aria-hidden />}
                                      </span>
                                      <span className="ai-composer-option-text">
                                        <strong>{option.label}</strong>
                                        <em>{option.hint}</em>
                                      </span>
                                      <span className="ai-composer-option-check">
                                        {selected ? <Check size={13} strokeWidth={2.4} aria-hidden /> : null}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>,
                              document.body,
                            )}
                          </div>
                          {currentMode === 'agent' ? (
                            <button
                              type="button"
                              className={`ai-composer-trigger muted ai-auto-run-toggle${aiAutoRunEnabled ? ' on' : ''}`}
                              aria-label="低风险自动执行"
                              aria-pressed={aiAutoRunEnabled}
                              title={aiAutoRunEnabled
                                ? '已开启：低风险终端/MCP 提案后自动执行（高风险与改文件仍需确认）'
                                : '关闭：每个动作都需你点授权'}
                              disabled={isAiGenerating}
                              onClick={() => {
                                setAiAutoRunEnabled((on) => {
                                  const next = !on;
                                  try {
                                    window.localStorage.setItem('pandaterm.ai.autoRun', next ? '1' : '0');
                                  } catch {
                                    /* ignore */
                                  }
                                  return next;
                                });
                              }}
                            >
                              <Zap size={12} className="ai-composer-trigger-icon" aria-hidden />
                              <span>自动</span>
                            </button>
                          ) : null}
                          {aiProviderConfig ? (
                            <div className="ai-composer-menu ai-composer-menu-model">
                              <button
                                type="button"
                                className={`ai-composer-trigger muted${aiComposerMenu === 'model' ? ' open' : ''}`}
                                aria-label="AI 模型"
                                aria-haspopup="listbox"
                                aria-expanded={aiComposerMenu === 'model'}
                                title={`${activeProviderName} · ${aiProviderConfig.model || '选择模型'}`}
                                disabled={isAiGenerating || isAiConfigSaving || Boolean(aiProviderConfig.error)}
                                onClick={(event) => toggleComposerMenu('model', event.currentTarget)}
                              >
                                <span>{aiProviderConfig.model || '选择模型'}</span>
                                <ChevronDown size={12} aria-hidden />
                              </button>
                              {aiComposerMenu === 'model' && aiComposerMenuAnchor && createPortal(
                                <div
                                  className="ai-composer-popover provider-model"
                                  role="dialog"
                                  aria-label="选择供应商与模型"
                                  style={composerPopoverStyle}
                                >
                                  <div className="ai-composer-picker-body">
                                    <div className="ai-composer-picker-col providers">
                                      <div className="ai-composer-popover-label">供应商</div>
                                      <div className="ai-composer-picker-list" role="listbox" aria-label="供应商列表">
                                        {providerAccounts.map((account) => {
                                          const selected = account.id === activeProviderId;
                                          return (
                                            <button
                                              type="button"
                                              key={account.id}
                                              role="option"
                                              aria-selected={selected}
                                              className={selected ? 'active' : undefined}
                                              onClick={() => {
                                                // 切换供应商后保持菜单打开，右侧模型列表随配置刷新
                                                void selectAiProviderAccountInChat(account.id);
                                              }}
                                            >
                                              <span className="ai-composer-option-text">
                                                <strong>{account.name || '未命名'}</strong>
                                                <em>
                                                  {account.model || '未选模型'}
                                                  {account.api_key_configured ? '' : ' · 未配置密钥'}
                                                </em>
                                              </span>
                                              <span className="ai-composer-option-check">
                                                {selected ? <Check size={13} strokeWidth={2.4} aria-hidden /> : null}
                                              </span>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                    <div className="ai-composer-picker-col models">
                                      <div className="ai-composer-popover-label">
                                        模型 · {activeProviderName}
                                      </div>
                                      <div className="ai-composer-picker-list" role="listbox" aria-label="模型列表">
                                        {modelOptions.length === 0 ? (
                                          <div className="ai-composer-popover-empty">当前供应商暂无可用模型</div>
                                        ) : modelOptions.map((model) => {
                                          const selected = model === aiProviderConfig.model;
                                          return (
                                            <button
                                              type="button"
                                              key={model}
                                              role="option"
                                              aria-selected={selected}
                                              className={selected ? 'active' : undefined}
                                              onClick={() => {
                                                void selectAiModel(model);
                                                closeComposerMenu();
                                              }}
                                            >
                                              <span className="ai-composer-option-text single">
                                                <strong>{model}</strong>
                                              </span>
                                              <span className="ai-composer-option-check">
                                                {selected ? <Check size={13} strokeWidth={2.4} aria-hidden /> : null}
                                              </span>
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="ai-composer-popover-footer">
                                    <button
                                      type="button"
                                      className="ai-composer-popover-action"
                                      onClick={() => {
                                        closeComposerMenu();
                                        openAiSettings();
                                      }}
                                    >
                                      <Settings size={12} aria-hidden />
                                      管理供应商与模型…
                                    </button>
                                  </div>
                                </div>,
                                document.body,
                              )}
                            </div>
                          ) : (
                            <button type="button" className="ai-model-label is-action" onClick={() => openAiSettings()}>
                              尚未配置模型
                            </button>
                          )}
                          {aiProviderConfig ? (
                            <div className="ai-composer-menu ai-composer-menu-effort">
                              <button
                                type="button"
                                className={`ai-composer-trigger muted${aiComposerMenu === 'effort' ? ' open' : ''}`}
                                aria-label="推理强度"
                                aria-haspopup="listbox"
                                aria-expanded={aiComposerMenu === 'effort'}
                                title={currentEffortOption?.hint ?? '推理强度'}
                                disabled={isAiGenerating || isAiConfigSaving || Boolean(aiProviderConfig.error)}
                                onClick={(event) => toggleComposerMenu('effort', event.currentTarget)}
                              >
                                <span>{currentEffortOption?.label ?? '默认'}</span>
                                <ChevronDown size={12} aria-hidden />
                              </button>
                              {aiComposerMenu === 'effort' && aiComposerMenuAnchor && createPortal(
                                <div
                                  className="ai-composer-popover effort"
                                  role="listbox"
                                  aria-label="选择推理强度"
                                  style={composerPopoverStyle}
                                >
                                  <div className="ai-composer-popover-label">推理强度</div>
                                  {AI_REASONING_EFFORT_OPTIONS.map((option) => {
                                    const selected = option.value === currentEffort;
                                    return (
                                      <button
                                        type="button"
                                        key={option.value}
                                        role="option"
                                        aria-selected={selected}
                                        className={selected ? 'active' : undefined}
                                        onClick={() => {
                                          void selectAiReasoningEffort(option.value);
                                          closeComposerMenu();
                                        }}
                                      >
                                        <span className="ai-composer-option-text">
                                          <strong>{option.label}</strong>
                                          <em>{option.hint}</em>
                                        </span>
                                        <span className="ai-composer-option-check">
                                          {selected ? <Check size={13} strokeWidth={2.4} aria-hidden /> : null}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>,
                                document.body,
                              )}
                            </div>
                          ) : null}
                          <div className="ai-composer-menu ai-composer-menu-context">
                            <button
                              type="button"
                              className={`ai-context-usage${aiComposerMenu === 'context' ? ' open' : ''} ${contextTone}`}
                              aria-label="上下文用量"
                              aria-haspopup="dialog"
                              aria-expanded={aiComposerMenu === 'context'}
                              title={`上下文 ${contextUsage.percent}% · ${formatAiContextAmount(contextUsage.usedChars)} / ${formatAiContextAmount(contextUsage.budgetChars)}`}
                              onClick={(event) => toggleComposerMenu('context', event.currentTarget)}
                            >
                              <svg className="ai-context-usage-ring" viewBox="0 0 20 20" aria-hidden>
                                <circle className="ai-context-usage-track" cx="10" cy="10" r="7" />
                                <circle
                                  className="ai-context-usage-progress"
                                  cx="10"
                                  cy="10"
                                  r="7"
                                  strokeDasharray={contextRingCircumference}
                                  strokeDashoffset={contextRingOffset}
                                />
                              </svg>
                              <span>{contextUsage.percent}%</span>
                            </button>
                            {aiComposerMenu === 'context' && aiComposerMenuAnchor && createPortal(
                              <div
                                className="ai-composer-popover context"
                                role="dialog"
                                aria-label="上下文用量"
                                style={composerPopoverStyle}
                              >
                                <div className="ai-composer-popover-label">上下文</div>
                                <div className="ai-context-usage-summary">
                                  <strong>{contextUsage.percent}%</strong>
                                  <span>
                                    {formatAiContextAmount(contextUsage.usedChars)}
                                    {' / '}
                                    {formatAiContextAmount(contextUsage.budgetChars)}
                                  </span>
                                </div>
                                <div className="ai-context-usage-rows">
                                  {([
                                    ['系统提示', contextUsage.systemChars],
                                    ['对话历史', contextUsage.historyChars],
                                    ['当前输入', contextUsage.draftChars],
                                    ['附加上下文', contextUsage.contextChars],
                                  ] as const).map(([label, chars]) => {
                                    const share = contextUsage.usedChars > 0
                                      ? Math.min(100, Math.round((chars / contextUsage.usedChars) * 100))
                                      : 0;
                                    return (
                                      <div className="ai-context-usage-row" key={label}>
                                        <div className="ai-context-usage-row-head">
                                          <span>{label}</span>
                                          <em>{formatAiContextAmount(chars)}</em>
                                        </div>
                                        <div className="ai-context-usage-bar">
                                          <i style={{ width: `${share}%` }} />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="ai-context-usage-meta">
                                  约 {contextUsage.messageCount} 条消息
                                  {contextUsage.contextCount > 0 ? ` · ${contextUsage.contextCount} 项上下文` : ''}
                                  · 估算值
                                </div>
                              </div>,
                              document.body,
                            )}
                          </div>
                        </>
                      );
                    })()}
                    {!aiProviderConfig?.api_key_configured && (
                      <button type="button" className="ai-model-label is-action warn" onClick={() => openAiSettings()}>
                        缺少密钥
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`ai-send-button${isAiGenerating ? ' stop' : ''}`}
                    onClick={() => isAiGenerating ? void stopCurrentAiGeneration() : void submitAiMessage()}
                    disabled={!isAiGenerating && !aiInput.trim()}
                    title={isAiGenerating ? '停止生成' : '发送消息'}
                  >
                    {isAiGenerating ? <Square size={12} fill="currentColor" /> : <CornerDownLeft size={15} />}
                  </button>
                </div>
              </div>
            </div>
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
                      onClick={() => toggleProcessSort('name')}
                      title="点击切换升序 / 降序"
                    >
                      名称 {processSortKey === 'name' && (processSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </div>
                    <div className="process-col process-col-status">状态</div>
                    <div
                      className={`process-col process-col-cpu${processSortKey === 'cpu' ? ' sorted' : ''}`}
                      onClick={() => toggleProcessSort('cpu')}
                      title="点击切换升序 / 降序"
                    >
                      CPU {processSortKey === 'cpu' && (processSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </div>
                    <div
                      className={`process-col process-col-mem${processSortKey === 'memory' ? ' sorted' : ''}`}
                      onClick={() => toggleProcessSort('memory')}
                      title="点击切换升序 / 降序"
                    >
                      内存 {processSortKey === 'memory' && (processSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </div>
                    <div className="process-col process-col-ports">端口</div>
                  </div>
                  {(() => {
                    const filtered = processList.filter((p) =>
                      !processSearch || p.name.toLowerCase().includes(processSearch.toLowerCase())
                    );
                    // desc = -1（默认降序，看最耗资源的在前）；asc = 1（再点一次同一列切换）
                    const dir = processSortDir === 'asc' ? 1 : -1;
                    const sorted = [...filtered].sort((a, b) => {
                      if (processSortKey === 'cpu') {
                        return (a.cpu_usage_percent - b.cpu_usage_percent) * dir;
                      }
                      if (processSortKey === 'memory') {
                        return (a.memory_bytes - b.memory_bytes) * dir;
                      }
                      return a.name.localeCompare(b.name) * dir;
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
                        <div className="process-col process-col-ports" title={p.ports || '无监听端口'}>
                          {p.ports || '-'}
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

        <section className="terminal-panel">
          <div className="workspace-body">
            {/* 无终端 workspace 时，统一标签栏独立成栏（编辑器/sftp/空态都依赖它做切换与新建入口） */}
            {activeTab && activeTab.kind !== 'terminal' && activeTab.kind !== 'rdp' && (
              <div className="terminal-pane-tabbar standalone">
                {renderUnifiedPaneTabbar(undefined, [], true)}
              </div>
            )}
            {/* 无终端会话时：编辑器占满主区；有终端时编辑嵌在 pane 内 */}
            {showEditor && (!activeTab || activeTab.kind !== 'terminal') ? (
              <EditorPanel
                tabs={editorTabs}
                activeTabId={activeEditorTabId}
                onSelectTab={selectEditorWorkspaceTab}
                onCloseTab={closeEditorTab}
                onSave={saveEditorFile}
                onContentChange={updateEditorContent}
                onCreateUntitled={createUntitledEditorTab}
                showTabBar={false}
                visible={showEditor}
              />
            ) : !activeTab ? (
              <div className="empty-workspace">
                <h2>没有活动标签页</h2>
                <p>点 + 打开连接管理，或从侧边栏发起连接。</p>
                <button className="empty-primary-action" onClick={() => openNewConnectionTab()}>
                  <Plus size={17} />
                  <span>新建连接</span>
                </button>
              </div>
            ) : (activeTab.kind === 'terminal' || activeTab.kind === 'rdp') ? (
              <div
                ref={terminalWorkspaceRef}
                className="terminal-pane"
                onPointerLeave={clearTerminalDragPreview}
              >
                {getWorkspaceDropPreview()}
                {getGhostTab()}
                {renderTerminalLayoutNode(activeTab.layout ?? createDefaultTerminalLayout(activeTab.id))}
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
                      <button className="media-viewer-close" title="关闭" onClick={() => closeMediaViewer()}>
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

          <ResourceBottomPanel
            onCancelTransfer={cancelUpload}
            openLocalTerminalKey={openLocalTerminalKey}
          />

          <StatusBar tabCount={tabs.length} />
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

      {terminalContextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: terminalContextMenu.x, top: terminalContextMenu.y }}
        >
          <button
            className="terminal-context-item"
            disabled={!terminalContextMenu.selection}
            onClick={() => void copyTerminalSelection(terminalContextMenu.tabId)}
          >
            复制
          </button>
          <button
            className="terminal-context-item"
            onClick={() => void pasteToTerminal(terminalContextMenu.tabId)}
          >
            粘贴
          </button>
          <button
            className="terminal-context-item"
            disabled={!terminalContextMenu.selection}
            onClick={() => searchTerminalSelection(terminalContextMenu.selection)}
          >
            浏览器搜索
          </button>
          <div className="terminal-context-sep" />
          <button
            className="terminal-context-item"
            onClick={() => clearTerminalScreen(terminalContextMenu.tabId)}
          >
            清屏
          </button>
        </div>
      )}

      {isAiSettingsOpen && (
        <div
          className={`ai-settings-backdrop${isAiSettingsWindow ? ' native-window' : ''}`}
          onMouseDown={() => {
            if (!isAiSettingsWindow && !isAiConfigSaving && !isAiModelsSyncing && !isMcpSaving) requestCloseAiSettings();
          }}
        >
          <div
            className="ai-settings-panel ai-settings-panel-cursor"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Cursor 风格：左侧导航 + 右侧内容 */}
            <aside className="ai-settings-sidebar" aria-label="设置导航">
              <div className="ai-settings-sidebar-top">
                <div className="ai-settings-sidebar-brand">
                  <Settings size={14} aria-hidden />
                  <span>Settings</span>
                </div>
                <label className="ai-settings-sidebar-search">
                  <Search size={13} aria-hidden />
                  <input
                    type="search"
                    value={aiSettingsNavQuery}
                    placeholder="Search settings"
                    spellCheck={false}
                    onChange={(event) => setAiSettingsNavQuery(event.target.value)}
                  />
                </label>
              </div>
              <nav className="ai-settings-nav">
                {(() => {
                  const navItems = ([
                    { id: 'models' as const, label: 'Models', icon: <Cpu size={14} aria-hidden /> },
                    { id: 'mcp' as const, label: 'MCP', icon: <Plug size={14} aria-hidden /> },
                  ]).filter((item) => {
                    const q = aiSettingsNavQuery.trim().toLowerCase();
                    return !q || item.label.toLowerCase().includes(q) || item.id.includes(q);
                  });
                  if (navItems.length === 0) {
                    return <div className="ai-settings-nav-empty">No matching settings</div>;
                  }
                  return navItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={aiSettingsTab === item.id ? 'active' : undefined}
                      onClick={() => setAiSettingsTab(item.id)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ));
                })()}
              </nav>
            </aside>

            <div className="ai-settings-main">
              <header className="ai-settings-main-header">
                <div className="ai-settings-main-title">
                  <h3>{aiSettingsTab === 'models' ? 'Models' : 'MCP'}</h3>
                </div>
                <button
                  type="button"
                  className="ai-settings-close"
                  aria-label="关闭"
                  disabled={isAiConfigSaving || isAiModelsSyncing || isMcpSaving}
                  onClick={() => requestCloseAiSettings()}
                >
                  <X size={16} />
                </button>
              </header>

              {aiSettingsTab === 'models' ? (
                <form
                  className="ai-settings-tab-panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitAiProviderConfig();
                  }}
                >
                  <div className="ai-settings-body">
                    <section className="ai-settings-section ai-settings-section-models">
                      <div className="ai-settings-model-list-block ai-settings-model-list-block-solo">
                        <div className="ai-settings-model-filter">
                          <Search size={14} aria-hidden />
                          <input
                            type="text"
                            value={aiModelListQuery}
                            placeholder="Filter models"
                            spellCheck={false}
                            disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing}
                            onChange={(event) => setAiModelListQuery(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setAiModelListQuery('');
                            }}
                          />
                          {aiModelListQuery ? (
                            <button
                              type="button"
                              className="ai-settings-model-filter-clear"
                              title="Clear filter"
                              onClick={() => setAiModelListQuery('')}
                            >
                              <X size={13} aria-hidden />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ai-settings-model-filter-sync"
                            title="Sync models from provider"
                            disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error) || !aiConfigDraft.base_url.trim()}
                            onClick={() => void syncAiModelsFromProvider()}
                          >
                            <RefreshCw size={14} className={isAiModelsSyncing ? 'spin' : undefined} aria-hidden />
                          </button>
                        </div>
                        {(() => {
                          const catalog = resolveAiModelCatalog(aiConfigDraft);
                          const disabled = isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error);
                          const query = aiModelListQuery.trim().toLowerCase();
                          const visibleModels = query
                            ? catalog.models.filter((model) => model.toLowerCase().includes(query))
                            : catalog.models;
                          if (catalog.models.length === 0) {
                            return <div className="ai-settings-model-empty">No models yet — set Base URL / Key then sync</div>;
                          }
                          if (visibleModels.length === 0) {
                            return <div className="ai-settings-model-empty">No models match “{aiModelListQuery.trim()}”</div>;
                          }
                          return (
                            <div className="ai-settings-model-list" role="listbox" aria-label="Models">
                              {visibleModels.map((model) => {
                                const isCurrent = model === catalog.model;
                                const isEnabled = catalog.enabled_models.includes(model);
                                const canDisable = isEnabled && !isCurrent && catalog.enabled_models.length > 1;
                                return (
                                  <div
                                    key={model}
                                    className={`ai-settings-model-row${isCurrent ? ' current' : ''}${isEnabled ? ' enabled' : ''}`}
                                    role="option"
                                    aria-selected={isCurrent}
                                  >
                                    <button
                                      type="button"
                                      className="ai-settings-model-name"
                                      disabled={disabled}
                                      title={isCurrent ? 'Current model' : 'Set as current model'}
                                      onClick={() => setAiDraftCurrentModel(model)}
                                    >
                                      <span>{model}</span>
                                      {isCurrent ? <em>Active</em> : null}
                                    </button>
                                    <button
                                      type="button"
                                      role="switch"
                                      aria-checked={isEnabled}
                                      className={`ai-settings-switch${isEnabled ? ' on' : ''}`}
                                      disabled={disabled || (isEnabled && !canDisable)}
                                      title={
                                        isEnabled
                                          ? (isCurrent ? 'Current model stays visible' : 'Hide from chat list')
                                          : 'Show in chat list'
                                      }
                                      onClick={() => toggleAiDraftEnabledModel(model)}
                                    >
                                      <i />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    </section>

                    <section className="ai-settings-section ai-settings-section-api-keys">
                      <button
                        type="button"
                        className="ai-settings-collapse-title"
                        aria-expanded={aiSettingsApiKeysOpen}
                        onClick={() => setAiSettingsApiKeysOpen((open) => !open)}
                      >
                        {aiSettingsApiKeysOpen
                          ? <ChevronDown size={15} aria-hidden />
                          : <ChevronRight size={15} aria-hidden />}
                        <span>API Keys</span>
                      </button>

                      {aiSettingsApiKeysOpen && (
                        <div className="ai-settings-collapse-body">
                          <div className="ai-settings-account-bar">
                            <div className="ai-settings-account-list" role="tablist" aria-label="API 账号">
                              {(aiProviderConfig?.accounts?.length
                                ? aiProviderConfig.accounts
                                : [{
                                  id: aiConfigDraft.account_id || 'default',
                                  name: aiConfigDraft.account_name || '默认',
                                  base_url: aiConfigDraft.base_url,
                                  model: aiConfigDraft.model,
                                  api_format: aiConfigDraft.api_format,
                                  api_key_configured: Boolean(aiProviderConfig?.api_key_configured),
                                }]
                              ).map((account) => {
                                const active = account.id === (aiConfigDraft.account_id || aiProviderConfig?.active_account_id);
                                const label = active
                                  ? (aiConfigDraft.account_name.trim() || account.name || '未命名')
                                  : (account.name || '未命名');
                                return (
                                  <button
                                    key={account.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    className={`ai-settings-account-chip${active ? ' active' : ''}`}
                                    title={label}
                                    disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting || Boolean(aiProviderConfig?.error)}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => void switchAiAccount(account.id)}
                                  >
                                    {label}
                                    {account.api_key_configured ? '' : ' ·未配置'}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="ai-settings-account-actions">
                              <button
                                type="button"
                                className="ai-settings-account-icon-btn"
                                title="添加账号"
                                aria-label="添加账号"
                                disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || isAiProviderTesting || Boolean(aiProviderConfig?.error)}
                                onClick={() => void addAiAccount()}
                              >
                                <Plus size={15} aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ai-settings-account-icon-btn danger"
                                title="删除当前账号"
                                aria-label="删除当前账号"
                                disabled={
                                  isAiConfigLoading
                                  || isAiConfigSaving
                                  || isAiModelsSyncing
                                  || isAiProviderTesting
                                  || Boolean(aiProviderConfig?.error)
                                  || (aiProviderConfig?.accounts?.length ?? 1) <= 1
                                  || !aiConfigDraft.account_id
                                }
                                onClick={() => void removeAiAccount(aiConfigDraft.account_id)}
                              >
                                <Trash2 size={15} aria-hidden />
                              </button>
                            </div>
                          </div>

                          <label className="ai-settings-row ai-settings-row-inline">
                            <div className="ai-settings-row-copy">
                              <span>供应商名称</span>
                            </div>
                            <input
                              className="ai-settings-input ai-settings-input-inline"
                              value={aiConfigDraft.account_name}
                              placeholder="例如 OpenAI / 公司中转"
                              spellCheck={false}
                              disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onChange={(event) => setAiConfigDraft((current) => ({
                                ...current,
                                account_name: event.target.value,
                              }))}
                            />
                          </label>

                          <div className="ai-settings-divider" />

                          <div className="ai-settings-row ai-settings-row-inline">
                            <div className="ai-settings-row-copy">
                              <span>兼容格式</span>
                            </div>
                            <div className="ai-settings-select-inline">
                              <SelectDropdown
                                value={aiConfigDraft.api_format}
                                options={AI_API_FORMAT_OPTIONS}
                                aria-label="接口兼容格式"
                                disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                                onChange={(next) => setAiConfigDraft((current) => ({ ...current, api_format: next }))}
                              />
                            </div>
                          </div>

                          <div className="ai-settings-divider" />

                          <label className="ai-settings-row ai-settings-row-inline">
                            <div className="ai-settings-row-copy">
                              <span>接口地址</span>
                            </div>
                            <input
                              className="ai-settings-input ai-settings-input-inline"
                              value={aiConfigDraft.base_url}
                              placeholder="https://api.openai.com/v1"
                              spellCheck={false}
                              disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onChange={(event) => setAiConfigDraft((current) => ({ ...current, base_url: event.target.value }))}
                            />
                          </label>

                          <div className="ai-settings-divider" />

                          <label className="ai-settings-row ai-settings-row-inline">
                            <div className="ai-settings-row-copy">
                              <span>访问密钥</span>
                            </div>
                            <div className="ai-settings-secret ai-settings-secret-inline">
                              <input
                                ref={aiApiKeyInputRef}
                                type={isAiApiKeyVisible ? 'text' : 'password'}
                                className="ai-settings-input"
                                value={aiApiKeyDraft}
                                placeholder={aiProviderConfig?.api_key_configured && !aiApiKeyDraft ? '••••••••' : 'sk-...'}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                                onChange={(event) => setAiApiKeyDraft(event.target.value)}
                              />
                              <button
                                type="button"
                                className="ai-settings-secret-toggle"
                                aria-label={isAiApiKeyVisible ? 'Hide key' : 'Show key'}
                                title={isAiApiKeyVisible ? 'Hide key' : 'Show key'}
                                disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                                onClick={() => setIsAiApiKeyVisible((current) => !current)}
                              >
                                {isAiApiKeyVisible
                                  ? <EyeOff size={15} aria-hidden />
                                  : <Eye size={15} aria-hidden />}
                              </button>
                            </div>
                          </label>

                          <div className="ai-settings-divider" />

                          <div className="ai-settings-model-probe-row">
                            <div className="ai-settings-model-probe-select">
                              <SelectDropdown
                                value={resolveAiTestModel(aiConfigDraft.models, aiTestModel, aiConfigDraft.model)}
                                options={aiConfigDraft.models.map((item) => ({ value: item, label: item }))}
                                placeholder={aiConfigDraft.models.length ? '选择测试模型' : '请先刷新模型'}
                                aria-label="选择测试模型"
                                disabled={
                                  isAiConfigLoading
                                  || isAiConfigSaving
                                  || isAiModelsSyncing
                                  || isAiProviderTesting
                                  || Boolean(aiProviderConfig?.error)
                                  || aiConfigDraft.models.length === 0
                                }
                                onChange={(next) => setAiTestModel(next)}
                              />
                            </div>
                            <button
                              type="button"
                              className="ai-settings-model-probe-icon-btn"
                              title="刷新模型列表"
                              aria-label="刷新模型列表"
                              disabled={
                                isAiConfigLoading
                                || isAiConfigSaving
                                || isAiModelsSyncing
                                || isAiProviderTesting
                                || Boolean(aiProviderConfig?.error)
                                || !aiConfigDraft.base_url.trim()
                              }
                              onClick={() => void syncAiModelsFromProvider()}
                            >
                              <RefreshCw size={15} className={isAiModelsSyncing ? 'spin' : undefined} aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ai-settings-btn primary ai-settings-model-probe-test-btn"
                              disabled={
                                isAiConfigLoading
                                || isAiConfigSaving
                                || isAiModelsSyncing
                                || isAiProviderTesting
                                || Boolean(aiProviderConfig?.error)
                                || !aiConfigDraft.base_url.trim()
                                || !resolveAiTestModel(aiConfigDraft.models, aiTestModel, aiConfigDraft.model)
                              }
                              onClick={() => void runAiProviderTest()}
                            >
                              {isAiProviderTesting ? '测试中…' : '测试模型'}
                            </button>
                          </div>
                        </div>
                      )}
                    </section>

                    {aiConfigError && <p className="ai-settings-error">{aiConfigError}</p>}
                  </div>

                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isAiConfigSaving || isAiModelsSyncing}
                      onClick={() => requestCloseAiSettings()}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="ai-settings-btn primary"
                      disabled={
                        isAiConfigLoading
                        || isAiConfigSaving
                        || isAiModelsSyncing
                        || Boolean(aiProviderConfig?.error)
                        || !aiConfigDraft.base_url.trim()
                        || !aiConfigDraft.model.trim()
                        || !isAiConfigDraftDirty(
                          aiConfigDraft,
                          aiApiKeyDraft,
                          aiApiKeyBaselineRef.current,
                          aiProviderConfig,
                        )
                      }
                    >
                      {isAiConfigSaving
                        ? '保存中…'
                        : isAiConfigDraftDirty(
                            aiConfigDraft,
                            aiApiKeyDraft,
                            aiApiKeyBaselineRef.current,
                            aiProviderConfig,
                          )
                          ? '保存'
                          : '已保存'}
                    </button>
                  </footer>
                </form>
              ) : (
                <div className="ai-settings-tab-panel">
                  <div className="ai-settings-body">
                    <section className="ai-settings-section ai-settings-section-flat">
                      <div className="ai-settings-section-title-row">
                        <div className="ai-settings-mcp-pane-tabs" role="tablist" aria-label="MCP 视图">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={mcpPane === 'installed'}
                            className={`ai-settings-mcp-pane-tab${mcpPane === 'installed' ? ' active' : ''}`}
                            disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                            onClick={() => switchMcpPane('installed')}
                          >
                            已安装
                            {mcpServersDraft.length > 0 ? (
                              <em>{mcpServersDraft.length}</em>
                            ) : null}
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={mcpPane === 'market'}
                            className={`ai-settings-mcp-pane-tab${mcpPane === 'market' ? ' active' : ''}`}
                            disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                            onClick={() => switchMcpPane('market')}
                          >
                            <Store size={13} aria-hidden />
                            市场
                          </button>
                        </div>
                        {mcpPane === 'installed' && (
                          <div className="ai-settings-mcp-actions">
                            <button
                              type="button"
                              className="ai-settings-ghost-btn"
                              disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                              onClick={() => void refreshMcpConfig()}
                            >
                              <RefreshCw size={14} className={isMcpLoading ? 'spin' : undefined} aria-hidden />
                              <span>刷新</span>
                            </button>
                            <button
                              type="button"
                              className={`ai-settings-ghost-btn${mcpImportOpen ? ' active' : ''}`}
                              disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                              onClick={() => void openMcpImportPanel()}
                            >
                              <Download size={14} aria-hidden />
                              <span>导入</span>
                            </button>
                            <button
                              type="button"
                              className="ai-settings-ghost-btn"
                              disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting || mcpServersDraft.length === 0}
                              title="导出为 Cursor 风格 mcp.json"
                              onClick={() => void exportMcpCursorJson()}
                            >
                              <Upload size={14} aria-hidden />
                              <span>{isMcpExporting ? '导出中…' : '导出'}</span>
                            </button>
                            <button
                              type="button"
                              className="ai-settings-ghost-btn primary-ghost"
                              disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                              onClick={() => {
                                const server = createEmptyMcpServer();
                                setMcpServersDraft((current) => [...current, server]);
                                openMcpServerJsonEditor(server);
                              }}
                            >
                              <Plus size={14} aria-hidden />
                              <span>新建MCP</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {mcpPane === 'market' && (
                        <div className="ai-settings-mcp-market">
                          <div className="ai-settings-mcp-market-head">
                            精选 MCP
                            <em>一键加入草稿 · 需本机已装 Node/npx 或 uvx</em>
                          </div>
                          <div className="ai-settings-mcp-market-toolbar">
                            <div className="ai-settings-model-filter">
                              <Search size={14} aria-hidden />
                              <input
                                type="text"
                                value={mcpMarketQuery}
                                placeholder="搜索名称、标签、包名…"
                                spellCheck={false}
                                disabled={isMcpSaving}
                                onChange={(event) => setMcpMarketQuery(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') setMcpMarketQuery('');
                                }}
                              />
                              {mcpMarketQuery ? (
                                <button
                                  type="button"
                                  className="ai-settings-model-filter-clear"
                                  title="清除搜索"
                                  onClick={() => setMcpMarketQuery('')}
                                >
                                  <X size={13} aria-hidden />
                                </button>
                              ) : null}
                            </div>
                            <div className="ai-settings-mcp-market-cats" role="tablist" aria-label="市场分类">
                              {MCP_MARKET_CATEGORIES.map((cat) => (
                                <button
                                  key={cat.id}
                                  type="button"
                                  role="tab"
                                  aria-selected={mcpMarketCategory === cat.id}
                                  className={`ai-settings-mcp-market-cat${mcpMarketCategory === cat.id ? ' active' : ''}`}
                                  disabled={isMcpSaving}
                                  onClick={() => setMcpMarketCategory(cat.id)}
                                >
                                  {cat.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="ai-settings-mcp-market-list">
                            {(() => {
                              const visible = filterMcpMarketItems(
                                MCP_MARKET_CATALOG,
                                mcpMarketQuery,
                                mcpMarketCategory,
                              );
                              if (visible.length === 0) {
                                return (
                                  <div className="ai-settings-model-empty">
                                    没有匹配的 MCP（共收录 {MCP_MARKET_CATALOG.length} 个精选服务）
                                  </div>
                                );
                              }
                              return visible.map((item) => {
                                const installed = mcpServersDraft.some((server) => server.id === item.id);
                                const initial = item.name.trim().charAt(0).toUpperCase() || 'M';
                                return (
                                  <div key={item.id} className={`ai-settings-mcp-market-card${installed ? ' installed' : ''}`}>
                                    <div className="ai-settings-mcp-market-card-info">
                                      <div className="ai-settings-mcp-avatar" aria-hidden>
                                        {initial}
                                      </div>
                                      <div className="ai-settings-mcp-market-card-main">
                                        <div className="ai-settings-mcp-market-card-title">
                                          <strong>{item.name}</strong>
                                          <em>{mcpMarketCategoryLabel(item.category)}</em>
                                          {item.tags.slice(0, 3).map((tag) => (
                                            <span key={tag} className="ai-settings-mcp-market-tag">{tag}</span>
                                          ))}
                                        </div>
                                        <p>{item.description}</p>
                                        <code>
                                          {item.config.transport === 'stdio'
                                            ? [item.config.command, ...(item.config.args ?? [])].join(' ')
                                            : item.config.url}
                                        </code>
                                        {(item.requiresEnv?.length || item.requiresArgs || item.note) ? (
                                          <small>
                                            {[
                                              item.requiresEnv?.length ? `需环境变量：${item.requiresEnv.join('、')}` : '',
                                              item.requiresArgs ? '需按本机修改参数' : '',
                                              item.note ?? '',
                                            ].filter(Boolean).join(' · ')}
                                          </small>
                                        ) : null}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      className={`ai-settings-ghost-btn${installed ? '' : ' primary-ghost'}`}
                                      disabled={isMcpSaving || Boolean(mcpBusyServerId) || installed}
                                      onClick={() => addMcpFromMarket(item)}
                                    >
                                      <Plus size={14} aria-hidden />
                                      <span>{installed ? '已添加' : '添加'}</span>
                                    </button>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          <p className="ai-settings-mcp-market-foot">
                            生态中有上千个社区 MCP，此处为官方 + 高星/常用精选（{MCP_MARKET_CATALOG.length} 个）。
                            更多可浏览{' '}
                            <span className="ai-settings-mcp-market-link">modelcontextprotocol/servers</span>
                            {' '}与{' '}
                            <span className="ai-settings-mcp-market-link">awesome-mcp-servers</span>
                            ，或切到「已安装」用「导入」从 Cursor/Claude 配置合并。
                          </p>
                        </div>
                      )}

                      {mcpPane === 'installed' && mcpImportOpen && (
                        <div className="ai-settings-mcp-import">
                          <div className="ai-settings-mcp-import-title">
                            导入 Cursor / Claude MCP 配置
                            <em>合并到草稿 · 点「保存 MCP」后才会写入磁盘</em>
                          </div>
                          <div className="ai-settings-mcp-import-strategy" role="radiogroup" aria-label="导入策略">
                            <button
                              type="button"
                              className={`ai-settings-mcp-strategy${mcpImportStrategy === 'overwrite' ? ' active' : ''}`}
                              disabled={isMcpImporting || isMcpSaving}
                              onClick={() => setMcpImportStrategy('overwrite')}
                            >
                              同 id 覆盖
                            </button>
                            <button
                              type="button"
                              className={`ai-settings-mcp-strategy${mcpImportStrategy === 'skip' ? ' active' : ''}`}
                              disabled={isMcpImporting || isMcpSaving}
                              onClick={() => setMcpImportStrategy('skip')}
                            >
                              同 id 跳过
                            </button>
                          </div>
                          <div className="ai-settings-mcp-import-path-row">
                            <input
                              className="ai-settings-input"
                              value={mcpImportPath}
                              placeholder="mcp.json 文件路径"
                              spellCheck={false}
                              disabled={isMcpImporting || isMcpSaving}
                              onChange={(event) => setMcpImportPath(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void importMcpFromPath(mcpImportPath);
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="ai-settings-ghost-btn primary-ghost"
                              disabled={isMcpImporting || isMcpSaving || !mcpImportPath.trim()}
                              onClick={() => void importMcpFromPath(mcpImportPath)}
                            >
                              <Download size={14} aria-hidden />
                              <span>{isMcpImporting ? '导入中…' : '导入路径'}</span>
                            </button>
                          </div>
                          <div className="ai-settings-mcp-import-candidates">
                            {mcpImportCandidates.length === 0 ? (
                              <div className="ai-settings-model-empty">未发现候选配置路径</div>
                            ) : (
                              mcpImportCandidates.map((candidate) => (
                                <button
                                  key={candidate.id}
                                  type="button"
                                  className={`ai-settings-mcp-import-candidate${candidate.exists ? ' ready' : ''}${candidate.error ? ' error' : ''}`}
                                  disabled={!candidate.exists || Boolean(candidate.error) || isMcpImporting || isMcpSaving}
                                  title={candidate.error || candidate.path}
                                  onClick={() => {
                                    setMcpImportPath(candidate.path);
                                    void importMcpFromPath(candidate.path);
                                  }}
                                >
                                  <strong>{candidate.label}</strong>
                                  <code>{candidate.path}</code>
                                  <span>
                                    {!candidate.exists
                                      ? '不存在'
                                      : candidate.error
                                        ? '无效'
                                        : `${candidate.server_count ?? 0} 个服务器`}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}

                      {mcpPane === 'installed' && (
                      <div className="ai-settings-mcp-list-block">

                        {(() => {
                          const mcpDirty = isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot);
                          if (mcpServersDraft.length === 0) {
                            return (
                              <div className="ai-settings-model-empty">
                                尚未配置 MCP。可切换到「市场」一键添加，或点「新建MCP」手动配置。
                              </div>
                            );
                          }
                          return (
                          <div className="ai-settings-mcp-list">
                            {mcpDirty && (
                              <div className="ai-settings-mcp-dirty-hint">
                                有未保存更改 — 点「保存 MCP」写入配置，或点「重新连接」保存并连接。
                              </div>
                            )}
                            {mcpServersDraft.map((server) => {
                              const live = mcpSnapshot?.servers.find((item) => item.id === server.id);
                              const editing = expandedMcpServerId === server.id;
                              const busy = mcpBusyServerId === server.id;
                              const dirty = isMcpServerDraftDirty(server, mcpSnapshot);
                              const isPersisted = Boolean(mcpSnapshot?.servers.some((item) => item.id === server.id));
                              const tools = live?.tools ?? [];
                              const toolsExpanded = Boolean(mcpToolsExpandedIds[server.id]);
                              const statusDot = mcpServerStatusDot(live?.status, server.enabled);
                              const title = server.name.trim() || server.id;
                              const commandLine = formatMcpServerCommandLine(server);
                              const enabledToolCount = countEnabledMcpTools(tools, server.disabled_tools);
                              const toolsSummary = tools.length > 0
                                ? `${enabledToolCount} tools enabled`
                                : '0 tools enabled';
                              return (
                                <div
                                  key={server.id}
                                  className={`ai-settings-mcp-card${server.enabled ? ' enabled' : ''}${live?.status === 'error' ? ' error' : ''}${live?.status === 'connected' ? ' connected' : ''}${dirty ? ' dirty' : ''}${editing ? ' editing' : ''}`}
                                >
                                  <div className="ai-settings-mcp-card-main">
                                    <div className="ai-settings-mcp-card-info">
                                      <div className="ai-settings-mcp-avatar" aria-hidden>
                                        <span>{mcpServerAvatarLetter(server)}</span>
                                        <i className={`ai-settings-mcp-status-dot ${statusDot}`} title={mcpStatusLabel(server.enabled ? live?.status : 'disabled')} />
                                      </div>
                                      <div className="ai-settings-mcp-card-meta">
                                        <div className="ai-settings-mcp-title-row">
                                          <span className="ai-settings-mcp-title">{title}</span>
                                          {dirty && <em className="ai-settings-mcp-dirty">未保存</em>}
                                        </div>
                                        <button
                                          type="button"
                                          className={`ai-settings-mcp-cmd${toolsExpanded ? ' open' : ''}`}
                                          title={commandLine}
                                          disabled={tools.length === 0}
                                          aria-expanded={toolsExpanded}
                                          onClick={() => setMcpToolsExpandedIds((current) => ({
                                            ...current,
                                            [server.id]: !current[server.id],
                                          }))}
                                        >
                                          <span>{toolsSummary}</span>
                                          {tools.length > 0 && (
                                            toolsExpanded
                                              ? <ChevronUp size={12} aria-hidden />
                                              : <ChevronDown size={12} aria-hidden />
                                          )}
                                        </button>
                                        {toolsExpanded && tools.length > 0 && (
                                          <div className="ai-settings-mcp-tags expanded">
                                            {tools.map((tool) => {
                                              const toolOff = isMcpToolDisabled(tool.name, server.disabled_tools);
                                              return (
                                                <button
                                                  key={`${server.id}-${tool.name}`}
                                                  type="button"
                                                  className={`ai-settings-mcp-tag${toolOff ? ' off' : ' on'}`}
                                                  title={toolOff
                                                    ? `${tool.description || tool.name}（已禁用，不可调用）`
                                                    : (tool.description || tool.name)}
                                                  disabled={isMcpSaving || busy}
                                                  aria-pressed={!toolOff}
                                                  onClick={() => {
                                                    const disabled_tools = toggleMcpToolDisabled(server.disabled_tools, tool.name);
                                                    updateMcpServerDraft(server.id, { disabled_tools });
                                                    if (editing) {
                                                      syncMcpServerJsonEditor({ ...server, disabled_tools });
                                                    }
                                                  }}
                                                >
                                                  {tool.name}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="ai-settings-mcp-card-actions">
                                      <button
                                        type="button"
                                        className={`ai-settings-mcp-icon-btn${editing ? ' active' : ''}`}
                                        title={editing ? '收起编辑' : '编辑'}
                                        disabled={isMcpSaving || busy}
                                        onClick={() => {
                                          if (editing) {
                                            setExpandedMcpServerId(null);
                                            return;
                                          }
                                          openMcpServerJsonEditor(server);
                                        }}
                                      >
                                        <Pencil size={16} aria-hidden />
                                      </button>
                                      <button
                                        type="button"
                                        className="ai-settings-mcp-icon-btn danger"
                                        title="删除"
                                        disabled={isMcpSaving || busy}
                                        onClick={() => requestRemoveMcpServer(server.id)}
                                      >
                                        <Trash2 size={16} aria-hidden />
                                      </button>
                                      <button
                                        type="button"
                                        role="switch"
                                        aria-checked={server.enabled}
                                        className={`ai-settings-switch ai-settings-switch-compact${server.enabled ? ' on' : ''}`}
                                        disabled={isMcpSaving || busy}
                                        title={server.enabled ? '禁用服务器' : '启用服务器'}
                                        onClick={() => void toggleMcpServerEnabled(server.id)}
                                      >
                                        <i />
                                      </button>
                                    </div>
                                  </div>

                                  {editing && (
                                    <div className="ai-settings-mcp-card-body">
                                      <div className="ai-settings-mcp-json-editor">
                                        <div className="ai-settings-mcp-json-toolbar">
                                          <span className="ai-settings-mcp-json-label">mcp.json</span>
                                          <span className="ai-settings-mcp-json-hint">
                                            {isPersisted ? '已保存条目的 id 锁定' : '可改 id · 也支持粘贴 Cursor mcpServers'}
                                          </span>
                                        </div>
                                        <textarea
                                          className="ai-settings-mcp-json-input"
                                          value={mcpEditJsonById[server.id] ?? formatMcpServerJson(server)}
                                          spellCheck={false}
                                          disabled={isMcpSaving || busy}
                                          rows={16}
                                          aria-label={`${title} MCP JSON 配置`}
                                          onChange={(event) => applyMcpServerJsonText(server.id, event.target.value)}
                                        />
                                        {mcpEditJsonErrorById[server.id] && (
                                          <p className="ai-settings-error">{mcpEditJsonErrorById[server.id]}</p>
                                        )}
                                      </div>

                                      {live?.error && <p className="ai-settings-error">{live.error}</p>}

                                      <div className="ai-settings-mcp-card-footer">
                                        <button
                                          type="button"
                                          className="ai-settings-ghost-btn"
                                          disabled={isMcpSaving || busy || !server.enabled}
                                          onClick={() => void reconnectMcpServerDraft(server.id)}
                                        >
                                          <RefreshCw size={14} className={busy ? 'spin' : undefined} aria-hidden />
                                          <span>{busy ? '连接中…' : '重新连接'}</span>
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          );
                        })()}
                      </div>
                      )}
                    </section>

                    {mcpNotice && <p className="ai-settings-mcp-notice">{mcpNotice}</p>}
                    {mcpError && <p className="ai-settings-error">{mcpError}</p>}
                  </div>

                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isMcpSaving}
                      onClick={() => requestCloseAiSettings()}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="ai-settings-btn primary"
                      disabled={isMcpLoading || isMcpSaving || !isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot)}
                      onClick={() => void submitMcpConfig()}
                    >
                      {isMcpSaving ? '保存中…' : isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot) ? '保存 MCP' : '已保存'}
                    </button>
                  </footer>
                </div>
              )}
            </div>
          </div>
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

      {uploadConflictDialog && (
        <div className="dialog-backdrop" onMouseDown={() => resolveUploadConflictDialog(null)}>
          <div
            className="dialog-card upload-conflict-dialog"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') resolveUploadConflictDialog(null);
              if (e.key === 'Enter') {
                const action = uploadConflictDialog.action;
                const newName = uploadConflictDialog.newName.trim();
                if (action !== 'rename' || !isUploadConflictRenameInvalid(uploadConflictDialog)) {
                  resolveUploadConflictDialog(action === 'rename' ? { action, newName } : { action });
                }
              }
            }}
          >
            <h3>文件已存在</h3>
            <p className="dialog-message">目标目录中已经存在同名项目，请选择本次上传的处理方式。</p>
            <div className="upload-conflict-files">
              <div className="upload-conflict-file">
                <span className="upload-conflict-label">上传文件</span>
                <strong>{uploadConflictDialog.sourceName}</strong>
                <span>{formatFileSize(uploadConflictDialog.sourceSize)} · {formatModifiedTime(uploadConflictDialog.sourceModifiedMs)}</span>
              </div>
              <div className="upload-conflict-file existing">
                <span className="upload-conflict-label">已有项目</span>
                <strong>{uploadConflictDialog.target.name}</strong>
                <span>{uploadConflictDialog.target.type === 'directory' ? '文件夹' : uploadConflictDialog.target.size} · {uploadConflictDialog.target.modifiedTime}</span>
              </div>
            </div>
            <div className="upload-conflict-options">
              {([
                ['overwrite', '覆盖', '用新文件替换目标中的同名项目'],
                ['skip', '跳过', '保留已有项目，不上传该文件'],
                ['rename', '重命名', '使用新名称上传，保留已有项目'],
              ] as const).map(([action, label, hint]) => (
                <button
                  key={action}
                  className={uploadConflictDialog.action === action ? 'upload-conflict-option active' : 'upload-conflict-option'}
                  onClick={() => setUploadConflictDialog((current) => current ? { ...current, action } : current)}
                >
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </button>
              ))}
            </div>
            {uploadConflictDialog.action === 'rename' && (
              <input
                autoFocus
                className="dialog-input"
                value={uploadConflictDialog.newName}
                placeholder="输入新文件名"
                onChange={(e) => setUploadConflictDialog((current) => current ? { ...current, newName: e.target.value } : current)}
              />
            )}
            {uploadConflictDialog.action === 'rename' && isUploadConflictRenameInvalid(uploadConflictDialog) && (
              <p className="upload-conflict-warning">新文件名不能为空、不能包含路径分隔符，也不能与当前目录已有名称重复。</p>
            )}
            <label className="upload-conflict-apply-all">
              <input
                type="checkbox"
                checked={uploadConflictDialog.applyToAll}
                onChange={(e) => setUploadConflictDialog((current) => current ? { ...current, applyToAll: e.target.checked } : current)}
              />
              对后续冲突使用相同处理方式
            </label>
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => resolveUploadConflictDialog(null)}>取消</button>
              <button
                className="dialog-btn primary"
                disabled={uploadConflictDialog.action === 'rename' && isUploadConflictRenameInvalid(uploadConflictDialog)}
                onClick={() => {
                  const action = uploadConflictDialog.action;
                  const newName = uploadConflictDialog.newName.trim();
                  resolveUploadConflictDialog(action === 'rename' ? { action, newName } : { action });
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingTerminalPaste && (
        <div className="dialog-backdrop" onMouseDown={() => setPendingTerminalPaste(null)}>
          <div
            className="dialog-card terminal-paste-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setPendingTerminalPaste(null);
            }}
          >
            <h3>确认粘贴到终端</h3>
            <p className="dialog-message">
              剪贴板包含 {pendingTerminalPaste.lineCount} 行，原始大小 {formatTerminalPasteSize(pendingTerminalPaste.originalBytes)}。
              旧版或未启用 Bracketed Paste 的 Shell 可能立即执行其中的命令。
            </p>
            {pendingTerminalPaste.hasControlCharacters && (
              <p className="terminal-paste-warning">
                内容包含不可见控制字符；预览已用控制图片符号显示，粘贴后可能改变终端状态或触发快捷操作。
              </p>
            )}
            {pendingTerminalPaste.truncated && (
              <p className="terminal-paste-warning">
                内容超过安全上限，仅会粘贴前 {formatTerminalPasteSize(pendingTerminalPaste.pasteBytes)}。
              </p>
            )}
            <pre className="terminal-paste-preview">{pendingTerminalPaste.preview}</pre>
            {pendingTerminalPaste.previewTruncated && (
              <p className="terminal-paste-preview-note">预览已截断，不代表完整粘贴内容。</p>
            )}
            <div className="dialog-actions">
              <button className="dialog-btn" autoFocus onClick={() => setPendingTerminalPaste(null)}>取消</button>
              <button
                className="dialog-btn primary"
                onClick={() => {
                  const pending = pendingTerminalPaste;
                  setPendingTerminalPaste(null);
                  commitTerminalPaste(pending.tabId, pending);
                }}
              >
                仍然粘贴
              </button>
            </div>
          </div>
        </div>
      )}

      {aiProviderTestDialog.open && (
        <div
          className="dialog-backdrop"
          onMouseDown={() => {
            if (isAiProviderTesting) return;
            setAiProviderTestDialog({ open: false, lines: [], status: 'idle' });
          }}
        >
          <div
            className="dialog-card ai-provider-test-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3>测试模型</h3>
            <pre className="ai-provider-test-log" aria-live="polite">
              {aiProviderTestDialog.lines.join('\n')}
            </pre>
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn primary"
                disabled={isAiProviderTesting}
                autoFocus
                onClick={() => setAiProviderTestDialog({ open: false, lines: [], status: 'idle' })}
              >
                {isAiProviderTesting ? '测试中…' : '关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setConfirmDialog(null)}>
          <div
            className="dialog-card"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirmDialog(null);
            }}
          >
            <h3>{confirmDialog.title}</h3>
            <p className="dialog-message">{confirmDialog.message}</p>
            <div className="dialog-actions">
              <button className="dialog-btn" onClick={() => setConfirmDialog(null)}>取消</button>
              <button
                className={confirmDialog.danger ? 'dialog-btn danger' : 'dialog-btn primary'}
                autoFocus
                onClick={async () => {
                  const action = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  await action();
                }}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
