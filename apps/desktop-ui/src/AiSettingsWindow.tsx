import { useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Settings,
  Store,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  getAiProviderConfig,
  saveAiProviderConfig,
  syncAiProviderModels,
  testAiProvider,
  addAiProviderAccount,
  deleteAiProviderAccount,
  getMcpConfig,
  saveMcpConfig,
  reconnectMcpServer,
  listMcpImportCandidates,
  importMcpServersFromPath,
  exportMcpServersCursorJson,
  writeClipboardText,
  type AiProviderConfig,
  type McpServerConfig,
  type McpConfigSnapshot,
  type McpImportCandidate,
} from './api';
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
  type AiConfigDraft,
  type AiSettingsTab,
  AI_API_FORMAT_OPTIONS,
  AI_DEFAULT_CONTEXT_WINDOW,
  AI_REASONING_EFFORT_OPTIONS,
  DEFAULT_AI_CONFIG_DRAFT,
  createEmptyMcpServer,
  countEnabledMcpTools,
  formatMcpServerCommandLine,
  formatMcpServerJson,
  isMcpServerDraftDirty,
  isMcpServersDraftDirty,
  isMcpToolDisabled,
  mergeMcpServerImports,
  mcpServerAvatarLetter,
  mcpServerStatusDot,
  mcpStatusLabel,
  normalizeAiApiFormat,
  normalizeAiContextWindow,
  normalizeAiMaxTokens,
  parseMcpServerJsonText,
  resolveAiModelCatalog,
  resolveAiTestModel,
  buildAiProviderTestLog,
  formatAiTestDurationMs,
  aiConfigToDraft,
  aiConfigToProviderState,
  snapshotToMcpDraft,
  toggleMcpToolDisabled,
} from './aiSettingsModel';
import { SelectDropdown } from './SelectDropdown';
import { AiModelIcon } from './AiModelIcon';
import { createSettingsAutosave, type AutosaveStatus } from './aiSettingsAutosave';
import './styles.css';

const initialTab: AiSettingsTab = new URLSearchParams(window.location.search).get('tab') === 'mcp' ? 'mcp' : 'models';

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

export function AiSettingsWindow() {
  const allowCloseRef = useRef(false);
  const aiApiKeyBaselineRef = useRef('');
  const aiApiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const aiConfigRefreshGenerationRef = useRef(0);
  const aiConfigHydratedRef = useRef(false);
  const aiTransitionInFlightRef = useRef(false);
  const pendingAiTabRef = useRef<AiSettingsTab | null>(null);
  const [isAiTransitioning, setIsAiTransitioning] = useState(false);
  const mcpRefreshGenerationRef = useRef(0);
  const latestMcpServersRef = useRef<McpServerConfig[]>([]);
  const latestMcpSnapshotRef = useRef<McpConfigSnapshot | null>(null);

  const [aiSettingsTab, setAiSettingsTab] = useState<AiSettingsTab>(initialTab);
  const [aiSettingsNavQuery, setAiSettingsNavQuery] = useState('');
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const [aiConfigDraft, setAiConfigDraft] = useState<AiConfigDraft>({
    ...DEFAULT_AI_CONFIG_DRAFT,
  });
  const [isAiConfigLoading, setIsAiConfigLoading] = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<AutosaveStatus>('idle');
  const isAiConfigSaving = aiSaveStatus === 'saving';
  const [isAiModelsSyncing, setIsAiModelsSyncing] = useState(false);
  const [aiTestModel, setAiTestModel] = useState('');
  const [isAiProviderTesting, setIsAiProviderTesting] = useState(false);
  const [aiProviderTestDialog, setAiProviderTestDialog] = useState<{
    open: boolean;
    lines: string[];
    status: 'idle' | 'running' | 'done' | 'error';
  }>({ open: false, lines: [], status: 'idle' });
  /** 测试模型：前端实测等待时长（ms） */
  const [aiProviderTestElapsedMs, setAiProviderTestElapsedMs] = useState(0);
  const [aiConfigError, setAiConfigError] = useState('');
  const [isAiApiKeyVisible, setIsAiApiKeyVisible] = useState(false);
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('');
  const [aiModelView, setAiModelView] = useState<'overview' | 'detail'>('overview');
  const [aiModelListQuery, setAiModelListQuery] = useState('');
  const [aiNewModel, setAiNewModel] = useState('');

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
  /** 工具标签「Show more」展开的服务器 id */
  const [mcpToolsExpandedIds, setMcpToolsExpandedIds] = useState<Record<string, boolean>>({});
  const [mcpImportOpen, setMcpImportOpen] = useState(false);
  const [mcpImportCandidates, setMcpImportCandidates] = useState<McpImportCandidate[]>([]);
  const [mcpImportPath, setMcpImportPath] = useState('');
  const [mcpImportStrategy, setMcpImportStrategy] = useState<'overwrite' | 'skip'>('overwrite');
  const [isMcpImporting, setIsMcpImporting] = useState(false);
  const [isMcpExporting, setIsMcpExporting] = useState(false);
  /** MCP 页内：已安装 | 市场 */
  const [mcpPane, setMcpPane] = useState<'installed' | 'market'>('installed');
  const [mcpMarketQuery, setMcpMarketQuery] = useState('');
  const [mcpMarketCategory, setMcpMarketCategory] = useState<McpMarketCategoryId>('all');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null);

  type SaveDraft = { config: AiConfigDraft; apiKey: string };
  const autosaveRef = useRef<ReturnType<typeof createSettingsAutosave<SaveDraft>> | null>(null);
  if (!autosaveRef.current) {
    autosaveRef.current = createSettingsAutosave<SaveDraft>({
      equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      onStatus: setAiSaveStatus,
      save: async ({ config: draft, apiKey }) => {
        const catalog = resolveAiModelCatalog(draft);
        let config: AiProviderConfig;
        try {
          config = await saveAiProviderConfig({
            ...draft,
            account_id: draft.account_id || undefined,
            account_name: draft.account_name.trim() || '默认',
            ...catalog,
            context_window: normalizeAiContextWindow(draft.context_window),
            max_tokens: normalizeAiMaxTokens(draft.max_tokens),
            use_api_key: true,
            activate: false,
          }, apiKey);
        } catch (error) {
          setAiConfigError('模型设置自动保存失败，请检查配置后重试。');
          throw error;
        }
        if (config.error) {
          const error = new Error('模型设置自动保存失败，请检查配置后重试。');
          setAiConfigError(error.message);
          throw error;
        }
        // 仅更新已保存快照，响应不能覆盖保存期间的新输入。
        setAiProviderConfig(aiConfigToProviderState(config));
        setAiConfigDraft((current) => ({
          ...current,
          context_window: current.context_window === draft.context_window ? config.context_window : current.context_window,
          max_tokens: current.max_tokens === draft.max_tokens ? config.max_tokens : current.max_tokens,
        }));
        aiApiKeyBaselineRef.current = apiKey;
        setAiConfigError('');
        void emitTo('main', 'ai-provider-config-changed').catch(() => undefined);
      },
    });
  }
  const autosave = autosaveRef.current;
  const latestDraftRef = useRef<SaveDraft>({ config: aiConfigDraft, apiKey: aiApiKeyDraft });
  latestDraftRef.current = { config: aiConfigDraft, apiKey: aiApiKeyDraft };
  latestMcpServersRef.current = mcpServersDraft;
  latestMcpSnapshotRef.current = mcpSnapshot;

  useEffect(() => {
    if (!aiProviderConfig || isAiConfigLoading || isAiModelsSyncing) return;
    autosave.update({ config: aiConfigDraft, apiKey: aiApiKeyDraft });
  }, [aiConfigDraft, aiApiKeyDraft, isAiConfigLoading, isAiModelsSyncing, autosave]);

  async function flushAiSettings() {
    if (!aiConfigHydratedRef.current) return true;
    autosave.update(latestDraftRef.current);
    return await autosave.flush();
  }

  async function withAiTransition(action: () => void | Promise<void>) {
    if (aiTransitionInFlightRef.current) return;
    aiTransitionInFlightRef.current = true;
    setIsAiTransitioning(true);
    try {
      if (!await flushAiSettings()) return;
      await action();
    } finally {
      aiTransitionInFlightRef.current = false;
      setIsAiTransitioning(false);
      const pendingTab = pendingAiTabRef.current;
      pendingAiTabRef.current = null;
      if (pendingTab) void openTab(pendingTab);
    }
  }

  useEffect(() => {
    if (aiSaveStatus === 'idle' || aiSaveStatus === 'saved') setAiConfigError('');
  }, [aiSaveStatus]);

  function applyAiProviderConfigState(config: AiProviderConfig) {
    const catalog = resolveAiModelCatalog(config);
    setAiProviderConfig(aiConfigToProviderState(config));
    setAiConfigDraft(aiConfigToDraft(config));
    setAiTestModel((current) => resolveAiTestModel(catalog.models, current, catalog.model));
  }

  function fillAiApiKeyFromConfig(config: AiProviderConfig) {
    const revealed = config.api_key?.trim() ?? '';
    aiApiKeyBaselineRef.current = revealed;
    setAiApiKeyDraft(revealed);
    setIsAiApiKeyVisible(false);
    const draft = { config: aiConfigToDraft(config), apiKey: revealed };
    latestDraftRef.current = draft;
    autosave.reset(draft);
    aiConfigHydratedRef.current = true;
  }

  async function withAiAccountSwitchGuard(action: () => void | Promise<void>) {
    await withAiTransition(action);
  }

  async function refreshAiProviderConfig(accountId?: string) {
    const generation = ++aiConfigRefreshGenerationRef.current;
    setIsAiConfigLoading(true);
    setAiConfigError('');
    try {
      const config = await getAiProviderConfig(accountId);
      if (generation !== aiConfigRefreshGenerationRef.current) return;
      applyAiProviderConfigState(config);
      fillAiApiKeyFromConfig(config);
      if (config.api_key_configured && !(config.api_key?.trim()) && !config.error) {
        setAiConfigError('已配置密钥，但当前进程未能解密回填。请完全重启 PandaTerm 后再打开设置。');
      }
      if (config.error) setAiConfigError(config.error);
      return !config.error;
    } catch (error) {
      if (generation !== aiConfigRefreshGenerationRef.current) return false;
      setAiConfigError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (generation === aiConfigRefreshGenerationRef.current) setIsAiConfigLoading(false);
    }
  }

  async function addAiAccount() {
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting) return;
    withAiAccountSwitchGuard(async () => {
      setIsAiConfigLoading(true);
      setAiConfigError('');
      try {
        const config = await addAiProviderAccount(false);
        applyAiProviderConfigState(config);
        fillAiApiKeyFromConfig(config);
        setAiModelView('detail');
        setAiModelListQuery('');
        setAiNewModel('');
        void emitTo('main', 'ai-provider-config-changed');
      } catch (error) {
        setAiConfigError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsAiConfigLoading(false);
      }
    });
  }

  async function openAiAccount(accountId: string) {
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting) return;
    await withAiTransition(async () => {
      if (await refreshAiProviderConfig(accountId)) {
        setAiModelView('detail');
        setAiModelListQuery('');
        setAiNewModel('');
      }
    });
  }

  async function backToAiOverview() {
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting) return;
    await withAiTransition(async () => {
      if (await refreshAiProviderConfig()) setAiModelView('overview');
    });
  }

  async function selectDefaultAiModel(value: string) {
    const [accountId, model] = JSON.parse(value) as [string, string];
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting) return;
    await withAiTransition(async () => {
      setIsAiConfigLoading(true);
      try {
        const target = await getAiProviderConfig(accountId);
        if (target.error) throw new Error(target.error);
        const config = await saveAiProviderConfig({
          ...aiConfigToDraft(target),
          model,
          enabled_models: Array.from(new Set([...target.enabled_models, model])),
          activate: true,
        });
        if (config.error) throw new Error(config.error);
        applyAiProviderConfigState(config);
        fillAiApiKeyFromConfig(config);
        void emitTo('main', 'ai-provider-config-changed').catch(() => undefined);
      } catch {
        setAiConfigError('默认模型设置失败，请重试。');
      } finally {
        setIsAiConfigLoading(false);
      }
    });
  }

  function addAiModel() {
    const model = aiNewModel.trim();
    if (!model) return;
    setAiConfigDraft((current) => ({
      ...current,
      models: Array.from(new Set([...current.models, model])),
      enabled_models: Array.from(new Set([...current.enabled_models, model])),
    }));
    setAiNewModel('');
    setAiModelListQuery('');
  }

  function selectAiModel(model: string) {
    const nextModel = model.trim();
    if (!nextModel) return;
    setAiConfigDraft((current) => ({
      ...current,
      model: nextModel,
      models: current.models.includes(nextModel) ? current.models : [...current.models, nextModel],
      enabled_models: current.enabled_models.includes(nextModel) ? current.enabled_models : [...current.enabled_models, nextModel],
    }));
  }

  function toggleAiModel(model: string) {
    setAiConfigDraft((current) => {
      const enabled = current.enabled_models.includes(model);
      if (enabled && (model === current.model || current.enabled_models.length <= 1)) return current;
      return {
        ...current,
        enabled_models: enabled
          ? current.enabled_models.filter((item) => item !== model)
          : [...current.enabled_models, model],
      };
    });
  }

  async function removeAiAccount(accountId: string) {
    const targetId = accountId.trim();
    if (!targetId) return;
    if ((aiProviderConfig?.accounts?.length ?? 0) <= 1) {
      setAiConfigError('至少保留一个 AI 账号');
      return;
    }
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting) return;
    setConfirmDialog({
      title: '删除账号？',
      message: '将删除该账号的接口与密钥配置，且不可恢复。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        void withAiTransition(async () => {
          setIsAiConfigLoading(true);
          setAiConfigError('');
          try {
            const config = await deleteAiProviderAccount(targetId);
            applyAiProviderConfigState(config);
            fillAiApiKeyFromConfig(config);
            setAiModelView('overview');
            void emitTo('main', 'ai-provider-config-changed');
          } catch (error) {
            setAiConfigError(error instanceof Error ? error.message : String(error));
          } finally {
            setIsAiConfigLoading(false);
          }
        });
      },
    });
  }

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

  async function openTab(tab: AiSettingsTab) {
    if (aiTransitionInFlightRef.current) {
      pendingAiTabRef.current = tab;
      return;
    }
    await withAiTransition(async () => {
      setAiSettingsTab(tab === 'mcp' ? 'mcp' : 'models');
      setAiModelView('overview');
      setAiSettingsNavQuery('');
      setMcpError('');
      await Promise.all([refreshAiProviderConfig(), refreshMcpConfig()]);
    });
  }

  function completeClose() {
    // 隐藏复用，避免下次打开冷启动整个 Webview（与连接窗口一致）
    allowCloseRef.current = false;
    void import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().hide())
      .catch((error) => console.error('Failed to hide AI settings window:', error));
  }

  async function requestClose() {
    if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting || isMcpSaving || mcpBusyServerId) return;
    if (aiProviderTestDialog.open) {
      setAiProviderTestDialog({ open: false, lines: [], status: 'idle' });
      return;
    }
    await withAiTransition(() => {
      const mcpDirty = isMcpServersDraftDirty(latestMcpServersRef.current, latestMcpSnapshotRef.current);
      if (!mcpDirty) {
        completeClose();
        return;
      }
      setConfirmDialog({
        title: '放弃未保存的更改？',
        message: 'MCP 有未保存的改动。关闭后将丢失这些草稿。',
        confirmLabel: '放弃更改',
        danger: true,
        onConfirm: () => { void withAiTransition(completeClose); },
      });
    });
  }

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;

  useEffect(() => {
    document.body.classList.add('has-ai-settings-window');
    document.documentElement.classList.add('ai-settings-window-html');
    openTabRef.current(initialTab);

    let disposed = false;
    let unlistenTab: (() => void) | null = null;
    let unlistenClose: (() => void) | null = null;
    const isWarm = new URLSearchParams(window.location.search).get('warm') === '1';

    void listen<{ tab: AiSettingsTab }>('ai-settings-set-tab', ({ payload }) => {
      if (!disposed) openTabRef.current(payload.tab === 'mcp' ? 'mcp' : 'models');
    }).then((remove) => { unlistenTab = remove; });

    void import('@tauri-apps/api/webviewWindow').then(async ({ getCurrentWebviewWindow }) => {
      const current = getCurrentWebviewWindow();
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('apply_window_dark_mode', { windowLabel: current.label });
      } catch (error) {
        console.warn('Failed to apply AI settings window dark mode:', error);
      }
      // warm 预热保持隐藏；冷启动时主进程 openAiSettingsWindow 已 show，这里再 focus 兜底
      if (!isWarm) {
        await current.show().catch(() => undefined);
        await current.setFocus().catch(() => undefined);
      }
      return current.onCloseRequested((event) => {
        // 始终拦截关闭 → hide，避免销毁预热实例
        event.preventDefault();
        requestCloseRef.current();
      });
    }).then((remove) => { unlistenClose = remove; });

    return () => {
      disposed = true;
      unlistenTab?.();
      unlistenClose?.();
      document.body.classList.remove('has-ai-settings-window');
      document.documentElement.classList.remove('ai-settings-window-html');
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (aiProviderTestDialog.open) {
        if (isAiProviderTesting) return;
        setAiProviderTestDialog({ open: false, lines: [], status: 'idle' });
        return;
      }
      if (confirmDialog) {
        setConfirmDialog(null);
        return;
      }
      if (isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting || isMcpSaving || mcpBusyServerId) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // 测试模型：请求中每 100ms 刷新前端实测等待时长，请求结束后保留最终值
  useEffect(() => {
    if (aiProviderTestDialog.status !== 'running') return;
    const startedAt = Date.now();
    setAiProviderTestElapsedMs(0);
    const timer = window.setInterval(() => {
      setAiProviderTestElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [aiProviderTestDialog.status]);

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
      onConfirm: () => {
        void (async () => {
          if (!isPersisted) {
            setMcpServersDraft((current) => current.filter((item) => item.id !== serverId));
            return;
          }
          setMcpBusyServerId(serverId);
          setIsMcpSaving(true);
          setMcpError('');
          try {
            const next = mcpServersDraft.filter((item) => item.id !== serverId);
            const saved = await saveMcpConfig(next);
            setMcpSnapshot(saved);
            setMcpServersDraft(snapshotToMcpDraft(saved));
            if (saved.error) setMcpError(saved.error);
            void emitTo('main', 'mcp-config-changed');
          } catch (error) {
            setMcpError(error instanceof Error ? error.message : String(error));
            void refreshMcpConfig();
          } finally {
            setIsMcpSaving(false);
            setMcpBusyServerId(null);
          }
        })();
      },
    });
  }

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
      void emitTo('main', 'mcp-config-changed');
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
      const invalidStdio = mcpServersDraft.find((server) => (
        server.enabled && server.transport === 'stdio' && !server.command.trim()
      ));
      if (invalidStdio) {
        setExpandedMcpServerId(invalidStdio.id);
        throw new Error(`MCP “${invalidStdio.name.trim() || invalidStdio.id}” 已启用但缺少启动命令`);
      }
      const invalidRemote = mcpServersDraft.find((server) => (
        server.enabled && server.transport !== 'stdio' && !server.url.trim()
      ));
      if (invalidRemote) {
        setExpandedMcpServerId(invalidRemote.id);
        throw new Error(`MCP “${invalidRemote.name.trim() || invalidRemote.id}” 已启用但缺少服务地址`);
      }
      const snapshot = await saveMcpConfig(mcpServersDraft);
      setMcpSnapshot(snapshot);
      setMcpServersDraft(snapshotToMcpDraft(snapshot));
      if (snapshot.error) setMcpError(snapshot.error);
      void emitTo('main', 'mcp-config-changed');
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
      const saved = await saveMcpConfig(mcpServersDraft);
      setMcpServersDraft(snapshotToMcpDraft(saved));
      const snapshot = await reconnectMcpServer(serverId);
      setMcpSnapshot(snapshot);
      setMcpServersDraft(snapshotToMcpDraft(snapshot));
      void emitTo('main', 'mcp-config-changed');
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
      if (preferred && !mcpImportPath.trim()) setMcpImportPath(preferred.path);
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
      setMcpNotice(`已导入 ${preview.server_count} 个服务器（${parts.join(' · ')}）。请检查后点击「保存 MCP」。`);
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

  async function submitAiProviderConfig() {
    await flushAiSettings();
  }

  async function syncAiModelsFromProvider() {
    if (isAiModelsSyncing || isAiConfigLoading) return;
    await withAiTransition(async () => {
    const { config: draft, apiKey } = latestDraftRef.current;
    setIsAiModelsSyncing(true);
    setAiConfigError('');
    try {
      const config = await syncAiProviderModels({
        account_id: draft.account_id || null,
        base_url: draft.base_url,
        use_api_key: true,
        api_key: apiKey || null,
        api_format: draft.api_format,
      });
      const catalog = resolveAiModelCatalog(config);
      const preferredModel = catalog.models.includes(draft.model) ? draft.model : catalog.model;
      const nextCatalog = resolveAiModelCatalog({
        model: preferredModel,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
      });
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
        account_name: current.account_name,
      }));
      setAiTestModel((current) => resolveAiTestModel(nextCatalog.models, current, nextCatalog.model));
      if (config.api_key) {
        const revealed = config.api_key.trim();
        aiApiKeyBaselineRef.current = revealed;
        setAiApiKeyDraft(revealed);
      }
      void emitTo('main', 'ai-provider-config-changed');
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiModelsSyncing(false);
    }
    });
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
        account_id: aiConfigDraft.account_id,
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

  const aiAccounts = aiProviderConfig?.accounts ?? [];
  const aiAccountCards = aiAccounts.length ? aiAccounts : [{
    id: aiConfigDraft.account_id || 'default',
    name: aiConfigDraft.account_name || '默认',
    base_url: aiConfigDraft.base_url,
    model: aiConfigDraft.model,
    api_format: aiConfigDraft.api_format,
    api_key_configured: Boolean(aiProviderConfig?.api_key_configured),
  }];
  const defaultAiAccount = aiAccountCards.find((account) => account.id === (aiProviderConfig?.active_account_id || aiConfigDraft.account_id));
  const defaultAiOptions = aiAccountCards.flatMap((account) => (
    (account.enabled_models?.length ? account.enabled_models : [account.model]).map((model) => ({
      value: JSON.stringify([account.id, model]),
      label: `${model} · ${account.name}`,
    }))
  ));
  const aiCatalog = resolveAiModelCatalog(aiConfigDraft);
  const visibleAiModels = aiCatalog.models.filter((model) => model.toLowerCase().includes(aiModelListQuery.trim().toLowerCase()));
  const aiControlsDisabled = isAiConfigLoading || isAiModelsSyncing || isAiProviderTesting || Boolean(aiProviderConfig?.error);

  return (
    <div className="ai-settings-window-root">
      <header className="connection-window-titlebar" data-tauri-drag-region>
        <span className="connection-window-title" data-tauri-drag-region>
          AI 设置 — PandaTerm
        </span>
        <button
          type="button"
          className="connection-window-titlebar-close"
          onClick={() => requestClose()}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </header>
      <div className="ai-settings-window-body" inert={isAiTransitioning} aria-busy={isAiTransitioning}>
          <div
            className="ai-settings-panel ai-settings-panel-cursor"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Cursor 风格：左侧导航 + 右侧内容 */}
            <aside className="ai-settings-sidebar" aria-label="设置导航">
              <nav className="ai-settings-nav">
                {(() => {
                  const navItems = ([
                    { id: 'models' as const, label: '模型设置', icon: <Cpu size={14} aria-hidden /> },
                    { id: 'mcp' as const, label: 'MCP服务器', icon: <Plug size={14} aria-hidden /> },
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
                      onClick={() => { void openTab(item.id); }}
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
                  <h3>{aiSettingsTab === 'models' ? '模型设置' : 'MCP服务器'}</h3>
                </div>
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
                    {aiModelView === 'overview' ? (
                      <div className="ai-model-overview">
                        <section className="ai-model-default-section">
                          <h4>新会话默认模型</h4>
                          <SelectDropdown
                            value={defaultAiAccount ? JSON.stringify([defaultAiAccount.id, defaultAiAccount.model]) : ''}
                            options={defaultAiOptions}
                            placeholder={isAiConfigLoading ? '加载中…' : '选择默认模型'}
                            aria-label="新会话默认模型"
                            disabled={aiControlsDisabled || !defaultAiOptions.length}
                            onChange={(value) => void selectDefaultAiModel(value)}
                          />
                        </section>
                        <section className="ai-upstreams-section">
                          <div className="ai-upstreams-heading">
                            <h4>上游</h4>
                            <button type="button" className="ai-settings-btn" disabled={aiControlsDisabled}
                              onClick={() => void addAiAccount()}><Plus size={14} aria-hidden />添加上游</button>
                          </div>
                          <div className="ai-upstream-grid">
                            {aiAccountCards.map((account) => (
                              <button type="button" className="ai-upstream-card" key={account.id}
                                disabled={aiControlsDisabled} onClick={() => void openAiAccount(account.id)}>
                                <AiModelIcon model={account.name} apiFormat={account.api_format} size={30} />
                                <span className="ai-upstream-card-copy">
                                  <strong>{account.name || '未命名上游'}</strong>
                                  <small>{AI_API_FORMAT_OPTIONS.find((option) => option.value === account.api_format)?.label || account.api_format} · {account.model || '未选择模型'}</small>
                                </span>
                                <ChevronDown className="ai-upstream-card-arrow" size={16} aria-hidden />
                              </button>
                            ))}
                          </div>
                        </section>
                      </div>
                    ) : (
                    <>
                    <button type="button" className="ai-upstream-back" disabled={aiControlsDisabled}
                      onClick={() => void backToAiOverview()}><ArrowLeft size={16} aria-hidden />返回模型</button>
                    <section className="ai-settings-section ai-settings-section-api-keys">
                      <div className="ai-settings-collapse-body">
                        <div className="ai-upstream-detail-heading">
                          <AiModelIcon model={aiConfigDraft.account_name} apiFormat={aiConfigDraft.api_format} size={32} />
                          <h4>{aiConfigDraft.account_name.trim() || '未命名上游'}</h4>
                          <button type="button" className="ai-settings-account-icon-btn danger" aria-label="删除上游"
                            disabled={aiControlsDisabled || aiAccounts.length <= 1}
                            onClick={() => void removeAiAccount(aiConfigDraft.account_id)}>
                            <Trash2 size={16} aria-hidden />
                          </button>
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
                            disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
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
                              disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
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
                            disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
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
                              disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onChange={(event) => setAiApiKeyDraft(event.target.value)}
                            />
                            <button
                              type="button"
                              className="ai-settings-secret-toggle"
                              aria-label={isAiApiKeyVisible ? 'Hide key' : 'Show key'}
                              title={isAiApiKeyVisible ? 'Hide key' : 'Show key'}
                              disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onClick={() => setIsAiApiKeyVisible((current) => !current)}
                            >
                              {isAiApiKeyVisible
                                ? <EyeOff size={15} aria-hidden />
                                : <Eye size={15} aria-hidden />}
                            </button>
                          </div>
                        </label>

                        <div className="ai-settings-divider" />

                        <label className="ai-settings-row ai-settings-row-inline">
                          <div className="ai-settings-row-copy">
                            <span>上下文窗口</span>
                          </div>
                          <input
                            className="ai-settings-input ai-settings-input-inline"
                            type="number"
                            inputMode="numeric"
                            min={1000}
                            step={1000}
                            value={aiConfigDraft.context_window || ''}
                            placeholder={`默认 ${AI_DEFAULT_CONTEXT_WINDOW}（token）`}
                            spellCheck={false}
                            disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                            onChange={(event) => setAiConfigDraft((current) => ({
                              ...current,
                              context_window: Number(event.target.value) || 0,
                            }))}
                          />
                        </label>

                        <div className="ai-settings-divider" />

                        <label className="ai-settings-row ai-settings-row-inline">
                          <div className="ai-settings-row-copy">
                            <span>最大输出 Token</span>
                          </div>
                          <input
                            className="ai-settings-input ai-settings-input-inline"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={1024}
                            value={aiConfigDraft.max_tokens || ''}
                            placeholder="默认（不限制，交给服务端）"
                            spellCheck={false}
                            disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                            onChange={(event) => setAiConfigDraft((current) => ({
                              ...current,
                              max_tokens: Number(event.target.value) || 0,
                            }))}
                          />
                        </label>

                        <div className="ai-settings-divider" />

                        <div className="ai-settings-row ai-settings-row-inline">
                          <div className="ai-settings-row-copy">
                            <span>默认推理强度</span>
                          </div>
                          <div className="ai-settings-select-inline">
                            <SelectDropdown
                              value={aiConfigDraft.reasoning_effort}
                              options={AI_REASONING_EFFORT_OPTIONS}
                              aria-label="默认推理强度"
                              disabled={isAiConfigLoading || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onChange={(next) => setAiConfigDraft((current) => ({ ...current, reasoning_effort: next }))}
                            />
                          </div>
                        </div>

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
                    </section>

                    <section className="ai-upstream-models">
                      <div className="ai-upstreams-heading">
                        <h4>模型 <span>{aiCatalog.models.length}</span></h4>
                        <button type="button" className="ai-settings-btn" disabled={aiControlsDisabled || !aiConfigDraft.base_url.trim()}
                          onClick={() => void syncAiModelsFromProvider()}>
                          <RefreshCw size={14} className={isAiModelsSyncing ? 'spin' : undefined} aria-hidden />从上游获取
                        </button>
                      </div>
                      <label className="ai-upstream-model-search">
                        <Search size={15} aria-hidden />
                        <input aria-label="搜索模型" placeholder="搜索模型" value={aiModelListQuery}
                          onChange={(event) => setAiModelListQuery(event.target.value)} />
                      </label>
                      <div className="ai-upstream-model-list">
                        {visibleAiModels.map((model) => (
                          <div role="button" tabIndex={aiControlsDisabled ? -1 : 0} className={`ai-upstream-model-row${model === aiCatalog.model ? ' current' : ''}`} key={model}
                            aria-disabled={aiControlsDisabled}
                            onClick={() => { if (!aiControlsDisabled) selectAiModel(model); }}
                            onKeyDown={(event) => { if (!aiControlsDisabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectAiModel(model); } }}>
                            <AiModelIcon model={model} apiFormat={aiConfigDraft.api_format} size={20} />
                            <span>{model}</span>
                            {model === aiCatalog.model && <small>当前</small>}
                            <button type="button" role="switch" aria-checked={aiCatalog.enabled_models.includes(model)}
                              aria-label={`启用 ${model}`} className="ai-upstream-model-toggle"
                              disabled={aiControlsDisabled || (aiCatalog.enabled_models.includes(model) && (model === aiCatalog.model || aiCatalog.enabled_models.length <= 1))}
                              onClick={(event) => { event.stopPropagation(); toggleAiModel(model); }}><span /></button>
                          </div>
                        ))}
                        {!visibleAiModels.length && <p className="ai-settings-nav-empty">没有匹配的模型</p>}
                      </div>
                      <div className="ai-upstream-add-model">
                        <input className="ai-settings-input" aria-label="模型名称" placeholder="输入模型名称" value={aiNewModel}
                          disabled={aiControlsDisabled} onChange={(event) => setAiNewModel(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAiModel(); } }} />
                        <button type="button" className="ai-settings-btn" disabled={aiControlsDisabled || !aiNewModel.trim()}
                          onClick={addAiModel}><Plus size={14} aria-hidden />添加模型</button>
                      </div>
                    </section>
                    </>
                    )}

                    {aiSaveStatus === 'error' && (
                      <p role="status" aria-live="polite">
                        自动保存失败，输入已保留。请重试，保存成功后再关闭或切换账号。
                      </p>
                    )}
                    {aiSaveStatus === 'error' && (
                      <button type="button" className="ai-settings-btn" onClick={() => void submitAiProviderConfig()}>
                        重试保存
                      </button>
                    )}
                    {aiConfigError && <p className="ai-settings-error">{aiConfigError}</p>}
                  </div>
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
                                : server.enabled && live?.status === 'connected'
                                  ? '0 tools enabled'
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
                      onClick={() => requestClose()}
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
              <span className="ai-provider-test-elapsed">
                {aiProviderTestDialog.status === 'running' ? '等待中' : '等待时间'}
                {' '}
                {formatAiTestDurationMs(aiProviderTestElapsedMs)}
              </span>
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
          <div className="dialog-card" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{confirmDialog.title}</h3>
            <p className="dialog-message">{confirmDialog.message}</p>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn" onClick={() => setConfirmDialog(null)}>取消</button>
              <button
                type="button"
                className={`dialog-btn primary${confirmDialog.danger ? ' danger' : ''}`}
                onClick={() => {
                  const action = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  action();
                }}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
