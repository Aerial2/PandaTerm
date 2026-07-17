import { useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import {
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
  type McpTransport,
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
  createEmptyMcpServer,
  countEnabledMcpTools,
  formatMcpServerCommandLine,
  isAiConfigDraftDirty,
  isMcpServerDraftDirty,
  isMcpServersDraftDirty,
  isMcpToolDisabled,
  mergeMcpServerImports,
  mcpServerAvatarLetter,
  mcpServerStatusDot,
  mcpStatusLabel,
  normalizeAiReasoningEffort,
  resolveAiModelCatalog,
  snapshotToMcpDraft,
  toggleMcpToolDisabled,
} from './aiSettingsModel';
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
  const mcpRefreshGenerationRef = useRef(0);

  const [aiSettingsTab, setAiSettingsTab] = useState<AiSettingsTab>(initialTab);
  const [aiSettingsNavQuery, setAiSettingsNavQuery] = useState('');
  const [aiModelListQuery, setAiModelListQuery] = useState('');
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const [aiConfigDraft, setAiConfigDraft] = useState<AiConfigDraft>({
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini'],
    enabled_models: ['gpt-4o-mini'],
    use_api_key: true,
  });
  const [isAiConfigLoading, setIsAiConfigLoading] = useState(false);
  const [isAiConfigSaving, setIsAiConfigSaving] = useState(false);
  const [isAiModelsSyncing, setIsAiModelsSyncing] = useState(false);
  const [aiConfigError, setAiConfigError] = useState('');
  const [isAiApiKeyVisible, setIsAiApiKeyVisible] = useState(false);
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('');

  const [mcpServersDraft, setMcpServersDraft] = useState<McpServerConfig[]>([]);
  const [mcpSnapshot, setMcpSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [isMcpLoading, setIsMcpLoading] = useState(false);
  const [isMcpSaving, setIsMcpSaving] = useState(false);
  const [mcpBusyServerId, setMcpBusyServerId] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState('');
  const [mcpNotice, setMcpNotice] = useState('');
  const [expandedMcpServerId, setExpandedMcpServerId] = useState<string | null>(null);
  /** 工具标签「Show more」展开的服务器 id */
  const [mcpToolsExpandedIds, setMcpToolsExpandedIds] = useState<Record<string, boolean>>({});
  const [mcpImportOpen, setMcpImportOpen] = useState(false);
  const [mcpImportCandidates, setMcpImportCandidates] = useState<McpImportCandidate[]>([]);
  const [mcpImportPath, setMcpImportPath] = useState('');
  const [mcpImportStrategy, setMcpImportStrategy] = useState<'overwrite' | 'skip'>('overwrite');
  const [isMcpImporting, setIsMcpImporting] = useState(false);
  const [isMcpExporting, setIsMcpExporting] = useState(false);
  const [mcpMarketOpen, setMcpMarketOpen] = useState(false);
  const [mcpMarketQuery, setMcpMarketQuery] = useState('');
  const [mcpMarketCategory, setMcpMarketCategory] = useState<McpMarketCategoryId>('all');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null);

  function applyAiProviderConfigState(config: AiProviderConfig) {
    const catalog = resolveAiModelCatalog(config);
    setAiProviderConfig({
      base_url: config.base_url,
      model: catalog.model,
      models: catalog.models,
      enabled_models: catalog.enabled_models,
      reasoning_effort: normalizeAiReasoningEffort(config.reasoning_effort),
      use_api_key: config.use_api_key,
      api_key_configured: config.api_key_configured,
      api_key: null,
      error: config.error,
    });
    setAiConfigDraft({
      base_url: config.base_url,
      model: catalog.model,
      models: catalog.models,
      enabled_models: catalog.enabled_models,
      use_api_key: config.use_api_key,
    });
  }

  async function refreshAiProviderConfig() {
    const generation = ++aiConfigRefreshGenerationRef.current;
    setIsAiConfigLoading(true);
    setAiConfigError('');
    try {
      const config = await getAiProviderConfig();
      if (generation !== aiConfigRefreshGenerationRef.current) return;
      const catalog = resolveAiModelCatalog(config);
      setAiProviderConfig({
        base_url: config.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        reasoning_effort: normalizeAiReasoningEffort(config.reasoning_effort),
        use_api_key: config.use_api_key,
        api_key_configured: config.api_key_configured,
        api_key: null,
        error: config.error,
      });
      setAiConfigDraft({
        base_url: config.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        use_api_key: config.use_api_key,
      });
      const revealed = config.api_key?.trim() ?? '';
      aiApiKeyBaselineRef.current = revealed;
      setAiApiKeyDraft(revealed);
      if (config.api_key_configured && !revealed && !config.error) {
        setAiConfigError('已配置密钥，但当前进程未能解密回填。请完全重启 PandaTerm 后再打开设置。');
      }
      if (config.error) setAiConfigError(config.error);
    } catch (error) {
      if (generation !== aiConfigRefreshGenerationRef.current) return;
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === aiConfigRefreshGenerationRef.current) setIsAiConfigLoading(false);
    }
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

  function openTab(tab: AiSettingsTab) {
    setAiSettingsTab(tab === 'mcp' ? 'mcp' : 'models');
    setAiSettingsNavQuery('');
    setAiModelListQuery('');
    setAiConfigError(aiProviderConfig?.error ?? '');
    setMcpError('');
    void refreshAiProviderConfig();
    void refreshMcpConfig();
  }

  function completeClose() {
    // 隐藏复用，避免下次打开冷启动整个 Webview（与连接窗口一致）
    allowCloseRef.current = false;
    void import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().hide())
      .catch((error) => console.error('Failed to hide AI settings window:', error));
  }

  function requestClose() {
    if (isAiConfigSaving || isAiModelsSyncing || isMcpSaving || mcpBusyServerId) return;
    const modelsDirty = isAiConfigDraftDirty(
      aiConfigDraft,
      aiApiKeyDraft,
      aiApiKeyBaselineRef.current,
      aiProviderConfig,
    );
    const mcpDirty = isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot);
    if (!modelsDirty && !mcpDirty) {
      completeClose();
      return;
    }
    const parts = [modelsDirty ? '模型' : null, mcpDirty ? 'MCP' : null].filter(Boolean).join(' / ');
    setConfirmDialog({
      title: '放弃未保存的更改？',
      message: `${parts} 有未保存的改动。关闭后将丢失这些草稿。`,
      confirmLabel: '放弃更改',
      danger: true,
      onConfirm: completeClose,
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
      if (confirmDialog) {
        setConfirmDialog(null);
        return;
      }
      if (isAiConfigSaving || isAiModelsSyncing || isMcpSaving || mcpBusyServerId) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function updateMcpServerDraft(serverId: string, patch: Partial<McpServerConfig>) {
    setMcpServersDraft((current) => current.map((server) => (
      server.id === serverId ? { ...server, ...patch } : server
    )));
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
      setExpandedMcpServerId(serverId);
      return;
    }
    if (nextEnabled && current.transport !== 'stdio' && !current.url.trim()) {
      setMcpError('请先填写服务地址，再启用远程 MCP 服务器');
      setExpandedMcpServerId(serverId);
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
    if (mcpImportOpen) {
      setMcpImportOpen(false);
      return;
    }
    setMcpMarketOpen(false);
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

  function openMcpMarketPanel() {
    if (isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting) return;
    if (mcpMarketOpen) {
      setMcpMarketOpen(false);
      return;
    }
    setMcpImportOpen(false);
    setMcpMarketOpen(true);
    setMcpError('');
    setMcpNotice('');
  }

  function addMcpFromMarket(item: McpMarketItem) {
    if (isMcpSaving || mcpBusyServerId) return;
    const existing = mcpServersDraft.find((server) => server.id === item.id);
    if (existing) {
      setExpandedMcpServerId(existing.id);
      setMcpMarketOpen(false);
      setMcpNotice(`「${item.name}」已在列表中，已展开该服务器。`);
      return;
    }
    const draft = marketItemToServerConfig(item);
    setMcpServersDraft((current) => [...current, draft]);
    setExpandedMcpServerId(draft.id);
    setMcpMarketOpen(false);
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

  function setAiDraftCurrentModel(model: string) {
    const nextModel = model.trim();
    if (!nextModel) return;
    setAiConfigDraft((current) => {
      const models = current.models.includes(nextModel) ? current.models : [...current.models, nextModel];
      const enabled_models = current.enabled_models.includes(nextModel)
        ? current.enabled_models
        : [...current.enabled_models, nextModel];
      return { ...current, model: nextModel, models, enabled_models };
    });
  }

  function toggleAiDraftEnabledModel(model: string) {
    const target = model.trim();
    if (!target) return;
    setAiConfigDraft((current) => {
      if (!current.models.includes(target)) return current;
      const isEnabled = current.enabled_models.includes(target);
      if (isEnabled) {
        if (target === current.model || current.enabled_models.length <= 1) return current;
        return { ...current, enabled_models: current.enabled_models.filter((item) => item !== target) };
      }
      return { ...current, enabled_models: [...current.enabled_models, target] };
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
        base_url: aiConfigDraft.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        reasoning_effort: aiProviderConfig?.reasoning_effort ?? 'none',
        use_api_key: aiConfigDraft.use_api_key,
      }, apiKey);
      applyAiProviderConfigState(config);
      void emitTo('main', 'ai-provider-config-changed');
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
        base_url: aiConfigDraft.base_url,
        use_api_key: aiConfigDraft.use_api_key,
        api_key: apiKey || null,
      });
      const catalog = resolveAiModelCatalog(config);
      setAiProviderConfig({
        base_url: config.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        reasoning_effort: normalizeAiReasoningEffort(config.reasoning_effort),
        use_api_key: config.use_api_key,
        api_key_configured: config.api_key_configured,
        api_key: null,
        error: config.error,
      });
      setAiConfigDraft((current) => {
        const preferredModel = catalog.models.includes(current.model) ? current.model : catalog.model;
        const next = resolveAiModelCatalog({
          model: preferredModel,
          models: catalog.models,
          enabled_models: catalog.enabled_models,
        });
        return {
          ...current,
          models: next.models,
          enabled_models: next.enabled_models,
          model: next.model,
        };
      });
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
  }

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
      <div className="ai-settings-window-body">
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
                    <section className="ai-settings-section">
                      <div className="ai-settings-section-title">API Keys</div>

                      <label className="ai-settings-row ai-settings-row-inline">
                        <div className="ai-settings-row-copy">
                          <span>Override OpenAI Base URL</span>
                          <em>Domain or full base URL; backend appends /chat/completions and /models</em>
                        </div>
                        <input
                          autoFocus
                          className="ai-settings-input ai-settings-input-inline"
                          value={aiConfigDraft.base_url}
                          placeholder="https://api.openai.com/v1"
                          spellCheck={false}
                          disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                          onChange={(event) => setAiConfigDraft((current) => ({ ...current, base_url: event.target.value }))}
                        />
                      </label>

                      <div className="ai-settings-divider" />

                      <div className="ai-settings-row ai-settings-row-toggle">
                        <div className="ai-settings-row-copy">
                          <span>OpenAI API Key</span>
                          <em>Bearer auth; stored locally in the credential vault</em>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={aiConfigDraft.use_api_key}
                          className={`ai-settings-switch${aiConfigDraft.use_api_key ? ' on' : ''}`}
                          disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                          onClick={() => setAiConfigDraft((current) => ({ ...current, use_api_key: !current.use_api_key }))}
                        >
                          <i />
                        </button>
                      </div>

                      {aiConfigDraft.use_api_key && (
                        <label className="ai-settings-row compact ai-settings-row-inline">
                          <div className="ai-settings-row-copy">
                            <span>Key</span>
                            <em>{aiProviderConfig?.api_key_configured && !aiApiKeyDraft ? 'Configured in vault' : 'Paste provider key'}</em>
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
                              aria-label={isAiApiKeyVisible ? '隐藏密钥' : '显示密钥'}
                              title={isAiApiKeyVisible ? '隐藏密钥' : '显示密钥'}
                              disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error)}
                              onClick={() => setIsAiApiKeyVisible((current) => !current)}
                            >
                              {isAiApiKeyVisible
                                ? <EyeOff size={15} aria-hidden />
                                : <Eye size={15} aria-hidden />}
                            </button>
                          </div>
                        </label>
                      )}
                    </section>

                    <section className="ai-settings-section ai-settings-section-models">
                      <div className="ai-settings-section-title-row">
                        <div className="ai-settings-section-title">Model Visibility</div>
                        <button
                          type="button"
                          className="ai-settings-ghost-btn"
                          title="从供应商同步 /models"
                          disabled={isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error) || !aiConfigDraft.base_url.trim()}
                          onClick={() => void syncAiModelsFromProvider()}
                        >
                          <RefreshCw size={14} className={isAiModelsSyncing ? 'spin' : undefined} aria-hidden />
                          <span>{isAiModelsSyncing ? 'Syncing…' : 'Sync Models'}</span>
                        </button>
                      </div>

                      <div className="ai-settings-model-list-block">
                        <div className="ai-settings-row-copy ai-settings-list-hint">
                          <span>Available Models</span>
                          <em>
                            {(() => {
                              const catalog = resolveAiModelCatalog(aiConfigDraft);
                              const query = aiModelListQuery.trim().toLowerCase();
                              const visibleCount = query
                                ? catalog.models.filter((model) => model.toLowerCase().includes(query)).length
                                : catalog.models.length;
                              const enabledCount = catalog.enabled_models.length;
                              if (catalog.models.length === 0) {
                                return 'Toggle visibility in chat · click name to set current';
                              }
                              return query
                                ? `${visibleCount} of ${catalog.models.length} · ${enabledCount} enabled in chat`
                                : `${catalog.models.length} models · ${enabledCount} enabled in chat`;
                            })()}
                          </em>
                        </div>
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
                        </div>
                        {(() => {
                          const catalog = resolveAiModelCatalog(aiConfigDraft);
                          const disabled = isAiConfigLoading || isAiConfigSaving || isAiModelsSyncing || Boolean(aiProviderConfig?.error);
                          const query = aiModelListQuery.trim().toLowerCase();
                          const visibleModels = query
                            ? catalog.models.filter((model) => model.toLowerCase().includes(query))
                            : catalog.models;
                          if (catalog.models.length === 0) {
                            return <div className="ai-settings-model-empty">No models yet — sync from provider</div>;
                          }
                          if (visibleModels.length === 0) {
                            return <div className="ai-settings-model-empty">No models match “{aiModelListQuery.trim()}”</div>;
                          }
                          return (
                            <div className="ai-settings-model-list" role="listbox" aria-label="模型列表">
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
                                      title={isCurrent ? '当前模型' : '设为当前模型'}
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
                                          ? (isCurrent ? '当前模型始终可见' : '从聊天列表移除')
                                          : '加入聊天列表'
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

                    {aiConfigError && <p className="ai-settings-error">{aiConfigError}</p>}
                  </div>

                  <footer className="ai-settings-footer">
                    <button
                      type="button"
                      className="ai-settings-btn"
                      disabled={isAiConfigSaving || isAiModelsSyncing}
                      onClick={() => requestClose()}
                    >
                      Cancel
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
                        ? 'Saving…'
                        : isAiConfigDraftDirty(
                            aiConfigDraft,
                            aiApiKeyDraft,
                            aiApiKeyBaselineRef.current,
                            aiProviderConfig,
                          )
                          ? 'Save'
                          : 'Saved'}
                    </button>
                  </footer>
                </form>
              ) : (
                <div className="ai-settings-tab-panel">
                  <div className="ai-settings-body">
                    <section className="ai-settings-section ai-settings-section-flat">
                      <div className="ai-settings-section-title-row">
                        <div className="ai-settings-section-title">已安装的 MCP 服务器</div>
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
                            className={`ai-settings-ghost-btn${mcpMarketOpen ? ' active' : ''}`}
                            disabled={isMcpLoading || isMcpSaving || isMcpImporting || isMcpExporting}
                            title="从精选市场添加 MCP"
                            onClick={() => openMcpMarketPanel()}
                          >
                            <Store size={14} aria-hidden />
                            <span>市场</span>
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
                              setExpandedMcpServerId(server.id);
                            }}
                          >
                            <Plus size={14} aria-hidden />
                            <span>新建服务器</span>
                          </button>
                        </div>
                      </div>

                      {mcpMarketOpen && (
                        <div className="ai-settings-mcp-market">
                          <div className="ai-settings-mcp-import-title">
                            MCP 市场
                            <em>精选常用服务 · 一键加入草稿 · 需本机已装 Node/npx 或 uvx</em>
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
                                return (
                                  <div key={item.id} className={`ai-settings-mcp-market-card${installed ? ' installed' : ''}`}>
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
                                    <button
                                      type="button"
                                      className={`ai-settings-ghost-btn${installed ? '' : ' primary-ghost'}`}
                                      disabled={isMcpSaving || Boolean(mcpBusyServerId)}
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
                            ，或用「导入」从 Cursor/Claude 配置合并。
                          </p>
                        </div>
                      )}

                      {mcpImportOpen && (
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

                      <div className="ai-settings-mcp-list-block">
                        {(() => {
                          const mcpDirty = isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot);
                          if (mcpServersDraft.length === 0) {
                            return (
                              <div className="ai-settings-model-empty">
                                尚未配置 MCP 服务器。可点「市场」一键添加，或「新建服务器」手动配置。
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
                                                  onClick={() => updateMcpServerDraft(server.id, {
                                                    disabled_tools: toggleMcpToolDisabled(server.disabled_tools, tool.name),
                                                  })}
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
                                        onClick={() => setExpandedMcpServerId(editing ? null : server.id)}
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
                                      <div className="ai-settings-field-grid">
                                        <label className="ai-settings-field">
                                          <span>显示名称</span>
                                          <input
                                            className="ai-settings-input"
                                            value={server.name}
                                            placeholder="显示名称"
                                            spellCheck={false}
                                            disabled={isMcpSaving || busy}
                                            onChange={(event) => updateMcpServerDraft(server.id, { name: event.target.value })}
                                          />
                                        </label>
                                        <label className="ai-settings-field">
                                          <span>标识 ID {isPersisted ? <em>保存后锁定</em> : <em>Agent 调用用</em>}</span>
                                          <input
                                            className="ai-settings-input"
                                            value={server.id}
                                            placeholder="id"
                                            spellCheck={false}
                                            disabled={isMcpSaving || busy || isPersisted}
                                            onChange={(event) => updateMcpServerDraft(server.id, { id: event.target.value })}
                                          />
                                        </label>
                                        <label className="ai-settings-field ai-settings-field-full">
                                          <span>传输方式 <em>本地进程 / 远程 HTTP 可连接</em></span>
                                          <select
                                            className="ai-settings-input"
                                            value={server.transport}
                                            disabled={isMcpSaving || busy}
                                            onChange={(event) => updateMcpServerDraft(server.id, {
                                              transport: event.target.value as McpTransport,
                                            })}
                                          >
                                            <option value="stdio">本地进程（stdio）</option>
                                            <option value="streamable-http">远程 HTTP（streamable-http）</option>
                                            <option value="sse">SSE（按 streamable-http 连接）</option>
                                          </select>
                                        </label>

                                        {server.transport === 'stdio' ? (
                                          <>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>启动命令</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.command}
                                                placeholder="npx / node / uvx …"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, { command: event.target.value })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>参数 <em>空格分隔</em></span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.args.join(' ')}
                                                placeholder="-y @modelcontextprotocol/server-filesystem ."
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  args: event.target.value.trim() ? event.target.value.trim().split(/\s+/) : [],
                                                })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>环境变量 <em>每行 KEY=VALUE</em></span>
                                              <textarea
                                                className="ai-settings-textarea"
                                                rows={3}
                                                value={Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\n')}
                                                placeholder="FOO=bar"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => {
                                                  const env: Record<string, string> = {};
                                                  for (const line of event.target.value.split(/\r?\n/)) {
                                                    const trimmed = line.trim();
                                                    if (!trimmed) continue;
                                                    const eq = trimmed.indexOf('=');
                                                    if (eq <= 0) continue;
                                                    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
                                                  }
                                                  updateMcpServerDraft(server.id, { env });
                                                }}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>工作目录</span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.cwd ?? ''}
                                                placeholder="可选，留空则用默认目录"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, {
                                                  cwd: event.target.value.trim() || null,
                                                })}
                                              />
                                            </label>
                                          </>
                                        ) : (
                                          <>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>服务地址 <em>http(s) · streamable-http</em></span>
                                              <input
                                                className="ai-settings-input"
                                                value={server.url}
                                                placeholder="https://example.com/mcp"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => updateMcpServerDraft(server.id, { url: event.target.value })}
                                              />
                                            </label>
                                            <label className="ai-settings-field ai-settings-field-full">
                                              <span>请求头 <em>每行 KEY=VALUE</em></span>
                                              <textarea
                                                className="ai-settings-textarea"
                                                rows={3}
                                                value={Object.entries(server.headers ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')}
                                                placeholder="Authorization=Bearer …"
                                                spellCheck={false}
                                                disabled={isMcpSaving || busy}
                                                onChange={(event) => {
                                                  const headers: Record<string, string> = {};
                                                  for (const line of event.target.value.split(/\r?\n/)) {
                                                    const trimmed = line.trim();
                                                    if (!trimmed) continue;
                                                    const eq = trimmed.indexOf('=');
                                                    if (eq <= 0) continue;
                                                    headers[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
                                                  }
                                                  updateMcpServerDraft(server.id, { headers });
                                                }}
                                              />
                                            </label>
                                            <p className="ai-settings-mcp-remote-note">
                                              远程地址使用 streamable-http 客户端（JSON / SSE 响应）。旧版纯 GET SSE 未实现。启用后可点「重新连接」探测工具。
                                            </p>
                                          </>
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
