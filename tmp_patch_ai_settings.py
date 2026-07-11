# -*- coding: utf-8 -*-
from pathlib import Path

path = Path(r"e:\Project\Rust\PandaTerm\apps\desktop-ui\src\App.tsx")
text = path.read_text(encoding="utf-8")

def replace_once(src: str, old: str, new: str, label: str) -> str:
    if old not in src:
        raise SystemExit(f"NOT FOUND: {label}")
    return src.replace(old, new, 1)

# 1) helper
text = replace_once(
    text,
    """function isMcpServersDraftDirty(
  draft: McpServerConfig[],
  snapshot: McpConfigSnapshot | null,
): boolean {
  const savedIds = new Set((snapshot?.servers ?? []).map((item) => item.id));
  if (draft.length !== savedIds.size) return true;
  if (draft.some((server) => !savedIds.has(server.id))) return true;
  return draft.some((server) => isMcpServerDraftDirty(server, snapshot));
}
""",
    """function isMcpServersDraftDirty(
  draft: McpServerConfig[],
  snapshot: McpConfigSnapshot | null,
): boolean {
  const savedIds = new Set((snapshot?.servers ?? []).map((item) => item.id));
  if (draft.length !== savedIds.size) return true;
  if (draft.some((server) => !savedIds.has(server.id))) return true;
  return draft.some((server) => isMcpServerDraftDirty(server, snapshot));
}

/** Models 草稿是否相对已保存供应商配置有变化（含待写入 API Key） */
function isAiConfigDraftDirty(
  draft: {
    base_url: string;
    model: string;
    models: string[];
    enabled_models: string[];
    use_api_key: boolean;
  },
  apiKeyDraft: string,
  saved: AiProviderConfig | null,
): boolean {
  if (apiKeyDraft.trim().length > 0) return true;
  if (!saved) return true;
  const draftCatalog = resolveAiModelCatalog(draft);
  const savedCatalog = resolveAiModelCatalog(saved);
  if (draft.base_url.trim() !== saved.base_url.trim()) return true;
  if (Boolean(draft.use_api_key) !== Boolean(saved.use_api_key)) return true;
  if (draftCatalog.model !== savedCatalog.model) return true;
  if (draftCatalog.models.join('\\0') !== savedCatalog.models.join('\\0')) return true;
  if (draftCatalog.enabled_models.join('\\0') !== savedCatalog.enabled_models.join('\\0')) return true;
  return false;
}
""",
    "helper",
)

# 2) openAiSettings + requestClose
text = replace_once(
    text,
    """  function openAiSettings(tab: 'models' | 'mcp' = 'models') {
    // 禁止把 React 事件对象当 tab（勿写 onClick={openAiSettings}）
    const nextTab: 'models' | 'mcp' = tab === 'mcp' ? 'mcp' : 'models';
    if (aiProviderConfig) {
      const catalog = resolveAiModelCatalog(aiProviderConfig);
      setAiConfigDraft({
        base_url: aiProviderConfig.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        use_api_key: aiProviderConfig.use_api_key,
      });
    }
    setAiSettingsTab(nextTab);
    setAiSettingsNavQuery('');
    setAiModelListQuery('');
    setMcpServerListQuery('');
    setAiConfigError(aiProviderConfig?.error ?? '');
    setMcpError('');
    setIsAiSettingsOpen(true);
    isAiSettingsOpenRef.current = true;
    // 打开时重新拉取，确保 vault 中的密钥可回填
    void refreshAiProviderConfig({ fillApiKey: true });
    void refreshMcpConfig();
  }
""",
    """  function openAiSettings(tab: 'models' | 'mcp' = 'models') {
    // 禁止把 React 事件对象当 tab（勿写 onClick={openAiSettings}）
    const nextTab: 'models' | 'mcp' = tab === 'mcp' ? 'mcp' : 'models';
    if (aiProviderConfig) {
      const catalog = resolveAiModelCatalog(aiProviderConfig);
      setAiConfigDraft({
        base_url: aiProviderConfig.base_url,
        model: catalog.model,
        models: catalog.models,
        enabled_models: catalog.enabled_models,
        use_api_key: aiProviderConfig.use_api_key,
      });
    }
    setAiSettingsTab(nextTab);
    setAiSettingsNavQuery('');
    setAiModelListQuery('');
    setMcpServerListQuery('');
    setAiConfigError(aiProviderConfig?.error ?? '');
    setMcpError('');
    setIsAiSettingsOpen(true);
    isAiSettingsOpenRef.current = true;
    // 打开时重新拉取，确保 vault 中的密钥可回填
    void refreshAiProviderConfig({ fillApiKey: true });
    void refreshMcpConfig();
  }

  /** 关闭设置：Models/MCP 任一侧有未保存改动时确认 */
  function requestCloseAiSettings() {
    if (isAiConfigSaving || isAiModelsSyncing || isMcpSaving || mcpBusyServerId) return;
    const modelsDirty = isAiConfigDraftDirty(aiConfigDraft, aiApiKeyDraft, aiProviderConfig);
    const mcpDirty = isMcpServersDraftDirty(mcpServersDraft, mcpSnapshot);
    if (!modelsDirty && !mcpDirty) {
      setIsAiSettingsOpen(false);
      return;
    }
    const parts = [
      modelsDirty ? 'Models' : null,
      mcpDirty ? 'MCP' : null,
    ].filter(Boolean).join(' / ');
    setConfirmDialog({
      title: '放弃未保存的更改？',
      message: `${parts} 有未保存的改动。关闭后将丢失这些草稿。`,
      confirmLabel: '放弃更改',
      danger: true,
      onConfirm: () => {
        setIsAiSettingsOpen(false);
      },
    });
  }
""",
    "openAiSettings",
)

# 3) Esc + nav filter effect
text = replace_once(
    text,
    """  // Esc 关闭 AI 设置（有其它对话框或保存中时不关）
  useEffect(() => {
    if (!isAiSettingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isAiConfigSaving || isAiModelsSyncing || isMcpSaving) return;
      if (confirmDialog || uploadConflictDialog || newItemDialog || renameDialog) return;
      event.preventDefault();
      setIsAiSettingsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isAiSettingsOpen,
    isAiConfigSaving,
    isAiModelsSyncing,
    isMcpSaving,
    confirmDialog,
    uploadConflictDialog,
    newItemDialog,
    renameDialog,
  ]);
""",
    """  // Esc 关闭 AI 设置（有其它对话框或保存中时不关；有脏草稿时确认）
  // 注意：requestCloseAiSettings 在组件后部声明，函数声明会在 App 作用域内提升
  useEffect(() => {
    if (!isAiSettingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isAiConfigSaving || isAiModelsSyncing || isMcpSaving || mcpBusyServerId) return;
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
    isMcpSaving,
    mcpBusyServerId,
    confirmDialog,
    uploadConflictDialog,
    newItemDialog,
    renameDialog,
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
      { id: 'models' as const, label: 'Models' },
      { id: 'mcp' as const, label: 'MCP' },
    ]).filter((item) => !q || item.label.toLowerCase().includes(q) || item.id.includes(q));
    if (items.length > 0 && !items.some((item) => item.id === aiSettingsTab)) {
      setAiSettingsTab(items[0].id);
    }
  }, [isAiSettingsOpen, aiSettingsNavQuery, aiSettingsTab]);
""",
    "esc-effect",
)

# 4) save models keeps panel open
text = replace_once(
    text,
    """      applyAiProviderConfigState(config);
      setAiApiKeyDraft('');
      setIsAiSettingsOpen(false);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiConfigSaving(false);
    }
  }
""",
    """      applyAiProviderConfigState(config);
      setAiApiKeyDraft('');
      setIsAiApiKeyVisible(false);
    } catch (error) {
      setAiConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAiConfigSaving(false);
    }
  }
""",
    "submit-ai",
)

# 5) toggle enable remote validation
text = replace_once(
    text,
    """    const nextEnabled = !current.enabled;
    if (nextEnabled && current.transport === 'stdio' && !current.command.trim()) {
      setMcpError('请先填写 Command，再启用该 MCP 服务器');
      setExpandedMcpServerId(serverId);
      return;
    }
""",
    """    const nextEnabled = !current.enabled;
    if (nextEnabled && current.transport === 'stdio' && !current.command.trim()) {
      setMcpError('请先填写 Command，再启用该 MCP 服务器');
      setExpandedMcpServerId(serverId);
      return;
    }
    if (nextEnabled && current.transport !== 'stdio' && !current.url.trim()) {
      setMcpError('请先填写 URL，再启用远程 MCP 服务器');
      setExpandedMcpServerId(serverId);
      return;
    }
""",
    "toggle-enable",
)

# 6) submit mcp remote validation
text = replace_once(
    text,
    """      // 启用但未填 command 的 stdio 草稿不允许保存
      const invalid = mcpServersDraft.find((server) => (
        server.enabled
        && server.transport === 'stdio'
        && !server.command.trim()
      ));
      if (invalid) {
        setExpandedMcpServerId(invalid.id);
        throw new Error(`MCP “${invalid.name.trim() || invalid.id}” 已启用但缺少 Command`);
      }
""",
    """      // 启用态缺少必要字段不允许保存
      const invalidStdio = mcpServersDraft.find((server) => (
        server.enabled
        && server.transport === 'stdio'
        && !server.command.trim()
      ));
      if (invalidStdio) {
        setExpandedMcpServerId(invalidStdio.id);
        throw new Error(`MCP “${invalidStdio.name.trim() || invalidStdio.id}” 已启用但缺少 Command`);
      }
      const invalidRemote = mcpServersDraft.find((server) => (
        server.enabled
        && server.transport !== 'stdio'
        && !server.url.trim()
      ));
      if (invalidRemote) {
        setExpandedMcpServerId(invalidRemote.id);
        throw new Error(`MCP “${invalidRemote.name.trim() || invalidRemote.id}” 已启用但缺少 URL`);
      }
""",
    "submit-mcp",
)

path.write_text(text, encoding="utf-8")
print("phase1 ok")