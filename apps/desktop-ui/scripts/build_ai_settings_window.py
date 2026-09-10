# -*- coding: utf-8 -*-
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / "src"
app_lines = (root / "App.tsx").read_text(encoding="utf-8").splitlines()

# 1-based lines 8254-9158: panel div through its closing tag
panel = "\n".join(app_lines[8253:9158])
panel = panel.replace("requestCloseAiSettings()", "requestClose()")
panel = re.sub(
    r'\n\s*<button\n\s*type="button"\n\s*className="ai-settings-close"[\s\S]*?</button>',
    "",
    panel,
    count=1,
)

header = r'''import { useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import {
  Clipboard,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Settings,
  Store,
  Trash2,
  Upload,
  X,
  ChevronDown,
  ChevronRight,
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
  isAiConfigDraftDirty,
  isMcpServerDraftDirty,
  isMcpServersDraftDirty,
  mergeMcpServerImports,
  mcpStatusLabel,
  normalizeAiReasoningEffort,
  resolveAiModelCatalog,
  snapshotToMcpDraft,
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
    setMcpServerListQuery('');
    setAiConfigError(aiProviderConfig?.error ?? '');
    setMcpError('');
    void refreshAiProviderConfig();
    void refreshMcpConfig();
  }

  function completeClose() {
    allowCloseRef.current = true;
    void import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().close())
      .catch((error) => console.error('Failed to close AI settings window:', error));
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
      await current.show();
      await current.setFocus();
      return current.onCloseRequested((event) => {
        if (allowCloseRef.current) return;
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
      {/* 系统原生标题栏；页面不再重复绘制 titlebar */}
      <div className="ai-settings-window-body">
'''

footer = r'''
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
'''

out = header + panel + "\n" + footer
(root / "AiSettingsWindow.tsx").write_text(out, encoding="utf-8")
print(f"wrote AiSettingsWindow.tsx ({len(out)} chars)")