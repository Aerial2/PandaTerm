import type { AiProviderConfig, McpConfigSnapshot, McpServerConfig, McpTransport } from './api';

export type AiSettingsTab = 'models' | 'mcp';

export type AiConfigDraft = {
  base_url: string;
  model: string;
  models: string[];
  enabled_models: string[];
  use_api_key: boolean;
};

export function resolveAiModelCatalog(config: Pick<AiProviderConfig, 'model' | 'models' | 'enabled_models'>) {
  const model = config.model.trim();
  const models = Array.from(new Set(
    (config.models?.length ? config.models : [model])
      .map((item) => item.trim())
      .filter(Boolean),
  ));
  if (model && !models.includes(model)) models.unshift(model);

  const enabledSource = config.enabled_models?.length ? config.enabled_models : models;
  const enabled_models = Array.from(new Set(
    enabledSource.map((item) => item.trim()).filter((item) => models.includes(item)),
  ));
  if (model && models.includes(model) && !enabled_models.includes(model)) {
    enabled_models.unshift(model);
  }
  if (enabled_models.length === 0 && models[0]) enabled_models.push(models[0]);

  return { model: model || models[0] || '', models, enabled_models };
}

function serializeMcpServerConfig(server: Pick<
  McpServerConfig,
  'id' | 'name' | 'transport' | 'command' | 'args' | 'env' | 'cwd' | 'url' | 'headers' | 'enabled' | 'disabled_tools'
>): string {
  const sortRecord = (record: Record<string, string>) => Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
  const disabled = [...(server.disabled_tools ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return JSON.stringify({
    id: server.id.trim(),
    name: server.name.trim(),
    transport: server.transport,
    command: server.command.trim(),
    args: [...(server.args ?? [])],
    env: sortRecord(server.env ?? {}),
    cwd: (server.cwd ?? '').trim() || null,
    url: (server.url ?? '').trim(),
    headers: sortRecord(server.headers ?? {}),
    enabled: Boolean(server.enabled),
    disabled_tools: disabled,
  });
}

export function isMcpServerDraftDirty(
  server: McpServerConfig,
  snapshot: McpConfigSnapshot | null,
): boolean {
  const saved = snapshot?.servers.find((item) => item.id === server.id);
  if (!saved) return true;
  return serializeMcpServerConfig(server) !== serializeMcpServerConfig({
    id: saved.id,
    name: saved.name,
    transport: (saved.transport as McpTransport) || 'stdio',
    command: saved.command,
    args: saved.args ?? [],
    env: saved.env ?? {},
    cwd: saved.cwd ?? null,
    url: saved.url ?? '',
    headers: saved.headers ?? {},
    enabled: saved.enabled,
    disabled_tools: saved.disabled_tools ?? [],
  });
}

export function isMcpServersDraftDirty(
  draft: McpServerConfig[],
  snapshot: McpConfigSnapshot | null,
): boolean {
  const savedIds = new Set((snapshot?.servers ?? []).map((item) => item.id));
  if (draft.length !== savedIds.size) return true;
  if (draft.some((server) => !savedIds.has(server.id))) return true;
  return draft.some((server) => isMcpServerDraftDirty(server, snapshot));
}

export function isAiConfigDraftDirty(
  draft: AiConfigDraft,
  apiKeyDraft: string,
  apiKeyBaseline: string,
  saved: AiProviderConfig | null,
): boolean {
  if (apiKeyDraft !== apiKeyBaseline) return true;
  if (!saved) return true;
  const draftCatalog = resolveAiModelCatalog(draft);
  const savedCatalog = resolveAiModelCatalog(saved);
  if (draft.base_url.trim() !== saved.base_url.trim()) return true;
  if (Boolean(draft.use_api_key) !== Boolean(saved.use_api_key)) return true;
  if (draftCatalog.model !== savedCatalog.model) return true;
  if (draftCatalog.models.join('\0') !== savedCatalog.models.join('\0')) return true;
  if (draftCatalog.enabled_models.join('\0') !== savedCatalog.enabled_models.join('\0')) return true;
  return false;
}

export function mergeMcpServerImports(
  existing: McpServerConfig[],
  imported: McpServerConfig[],
  strategy: 'overwrite' | 'skip' = 'overwrite',
): { next: McpServerConfig[]; added: number; updated: number; skipped: number } {
  const byId = new Map(existing.map((server) => [server.id, server]));
  const order = existing.map((server) => server.id);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of imported) {
    const id = (raw.id || '').trim();
    if (!id) continue;
    const nextServer: McpServerConfig = {
      id,
      name: (raw.name || id).trim(),
      transport: (raw.transport as McpTransport) || 'stdio',
      command: raw.command ?? '',
      args: Array.isArray(raw.args) ? raw.args : [],
      env: raw.env ?? {},
      cwd: raw.cwd ?? null,
      url: raw.url ?? '',
      headers: raw.headers ?? {},
      enabled: Boolean(raw.enabled),
      disabled_tools: Array.isArray(raw.disabled_tools) ? [...raw.disabled_tools] : [],
    };
    if (byId.has(id)) {
      if (strategy === 'overwrite') {
        updated += 1;
        byId.set(id, nextServer);
      } else {
        skipped += 1;
      }
    } else {
      added += 1;
      order.push(id);
      byId.set(id, nextServer);
    }
  }
  return {
    next: order.map((id) => byId.get(id)!).filter(Boolean),
    added,
    updated,
    skipped,
  };
}

export function snapshotToMcpDraft(snapshot: McpConfigSnapshot): McpServerConfig[] {
  return snapshot.servers.map((server) => ({
    id: server.id,
    name: server.name,
    transport: (server.transport as McpTransport) || 'stdio',
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd ?? null,
    url: server.url ?? '',
    headers: server.headers ?? {},
    enabled: server.enabled,
    disabled_tools: Array.isArray(server.disabled_tools) ? [...server.disabled_tools] : [],
  }));
}

export function createEmptyMcpServer(): McpServerConfig {
  const id = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: null,
    url: '',
    headers: {},
    enabled: false,
    disabled_tools: [],
  };
}

/** 启用中的工具数（总数减去 disabled_tools） */
export function countEnabledMcpTools(
  tools: Array<{ name: string }>,
  disabledTools?: string[] | null,
): number {
  const disabled = new Set((disabledTools ?? []).map((item) => item.trim()).filter(Boolean));
  return tools.filter((tool) => !disabled.has(tool.name)).length;
}

export function isMcpToolDisabled(toolName: string, disabledTools?: string[] | null): boolean {
  const name = toolName.trim();
  return (disabledTools ?? []).some((item) => item.trim() === name);
}

export function toggleMcpToolDisabled(
  disabledTools: string[] | undefined,
  toolName: string,
): string[] {
  const name = toolName.trim();
  if (!name) return [...(disabledTools ?? [])];
  const current = [...(disabledTools ?? [])].map((item) => item.trim()).filter(Boolean);
  if (current.includes(name)) {
    return current.filter((item) => item !== name);
  }
  return [...current, name];
}

export function mcpStatusLabel(status?: string | null) {
  switch (status) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'error': return '错误';
    case 'disabled': return '已禁用';
    case 'disconnected': return '未连接';
    default: return status || '未知';
  }
}

/** 卡片副标题：stdio 命令行 / 远程 URL */
export function formatMcpServerCommandLine(server: Pick<McpServerConfig, 'transport' | 'command' | 'args' | 'url'>): string {
  if (server.transport === 'stdio') {
    const parts = [server.command?.trim(), ...(server.args ?? []).map((item) => item.trim()).filter(Boolean)].filter(Boolean);
    return parts.join(' ') || '—';
  }
  return (server.url ?? '').trim() || '—';
}

/** 编辑框展示：与 ~/.pandaterm/mcp.json 中单条 server 字段一致（pretty JSON） */
export function formatMcpServerJson(server: McpServerConfig): string {
  const disabled = [...(server.disabled_tools ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const payload: Record<string, unknown> = {
    id: server.id.trim(),
    name: server.name.trim() || server.id.trim(),
    transport: server.transport || 'stdio',
    command: server.command ?? '',
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    cwd: (server.cwd ?? '').trim() || null,
    url: server.url ?? '',
    headers: { ...(server.headers ?? {}) },
    enabled: Boolean(server.enabled),
  };
  if (disabled.length > 0) {
    payload.disabled_tools = disabled;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
    else if (item == null) continue;
    else out[key] = String(item);
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).map((item) => item.trim()).filter(Boolean);
}

function normalizeTransport(value: unknown, hasUrl: boolean): McpTransport {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'sse') return 'sse';
  if (raw === 'streamable-http' || raw === 'http' || raw === 'streamable_http') return 'streamable-http';
  if (raw === 'stdio') return 'stdio';
  return hasUrl ? 'streamable-http' : 'stdio';
}

function cursorEntryToServer(
  id: string,
  entry: Record<string, unknown>,
): McpServerConfig {
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  const command = typeof entry.command === 'string' ? entry.command : '';
  const transport = normalizeTransport(entry.transport, Boolean(url) && !command.trim());
  const nameRaw = typeof entry.name === 'string' ? entry.name.trim() : '';
  const disabled = entry.disabled === true;
  const enabled = entry.enabled === undefined ? !disabled : Boolean(entry.enabled);
  return {
    id: id.trim(),
    name: nameRaw || id.trim(),
    transport,
    command,
    args: asStringArray(entry.args),
    env: asStringRecord(entry.env),
    cwd: typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : null,
    url,
    headers: asStringRecord(entry.headers),
    enabled,
    disabled_tools: asStringArray(entry.disabled_tools),
  };
}

function storeLikeToServer(
  raw: Record<string, unknown>,
  fallbackId: string,
  lockId: boolean,
): McpServerConfig {
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = lockId ? fallbackId : (rawId || fallbackId);
  return cursorEntryToServer(id, raw);
}

export type ParseMcpServerJsonResult =
  | { ok: true; server: McpServerConfig }
  | { ok: false; error: string };

/**
 * 解析编辑框 JSON：
 * - PandaTerm 单条 `{ id, command, ... }`（与 mcp.json 条目一致）
 * - PandaTerm store `{ version, servers: [...] }`（取第一条 / 匹配 fallbackId）
 * - Cursor `{ mcpServers: { id: {...} } }`
 */
export function parseMcpServerJsonText(
  text: string,
  options: { fallbackId: string; lockId?: boolean },
): ParseMcpServerJsonResult {
  const fallbackId = options.fallbackId.trim() || 'mcp-server';
  const lockId = Boolean(options.lockId);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 格式无效' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '需要 JSON 对象' };
  }
  const obj = raw as Record<string, unknown>;

  // Cursor / Claude Desktop
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const map = obj.mcpServers as Record<string, unknown>;
    const keys = Object.keys(map);
    if (keys.length === 0) return { ok: false, error: 'mcpServers 为空' };
    let key = keys.includes(fallbackId) ? fallbackId : keys[0];
    if (lockId) key = keys.includes(fallbackId) ? fallbackId : keys[0];
    const entry = map[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'mcpServers 条目无效' };
    }
    const id = lockId ? fallbackId : key.trim() || fallbackId;
    return { ok: true, server: cursorEntryToServer(id, entry as Record<string, unknown>) };
  }

  // PandaTerm store
  if (Array.isArray(obj.servers)) {
    const list = obj.servers.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ));
    if (list.length === 0) return { ok: false, error: 'servers 为空' };
    const matched = list.find((item) => typeof item.id === 'string' && item.id.trim() === fallbackId) ?? list[0];
    return { ok: true, server: storeLikeToServer(matched, fallbackId, lockId) };
  }

  // 单条 store 形态
  if (
    typeof obj.id === 'string'
    || typeof obj.command === 'string'
    || typeof obj.url === 'string'
    || typeof obj.transport === 'string'
  ) {
    return { ok: true, server: storeLikeToServer(obj, fallbackId, lockId) };
  }

  return { ok: false, error: '无法识别的 MCP 配置（需要单条 server、servers 或 mcpServers）' };
}

/** 头像字母：取显示名首字符 */
export function mcpServerAvatarLetter(server: Pick<McpServerConfig, 'name' | 'id'>): string {
  const source = (server.name.trim() || server.id.trim() || '?').trim();
  const ch = source.charAt(0);
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch || '?';
}

/** 状态点：connected | connecting | error | offline */
export function mcpServerStatusDot(status?: string | null, enabled?: boolean): 'online' | 'busy' | 'error' | 'offline' {
  if (!enabled) return 'offline';
  if (status === 'connected') return 'online';
  if (status === 'connecting') return 'busy';
  if (status === 'error') return 'error';
  return 'offline';
}

export function normalizeAiReasoningEffort(value?: string | null): string {
  const next = (value ?? 'none').trim().toLowerCase();
  const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  return allowed.has(next) ? next : 'none';
}
