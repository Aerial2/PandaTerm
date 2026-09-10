import type { AiApiFormat, AiProviderConfig, McpConfigSnapshot, McpServerConfig, McpTransport } from './api';
import type { SelectOption } from './SelectDropdown';

export type AiSettingsTab = 'models' | 'mcp';

export type AiConfigDraft = {
  account_id: string;
  account_name: string;
  base_url: string;
  model: string;
  models: string[];
  enabled_models: string[];
  api_format: AiApiFormat;
  /** 模型上下文窗口（token） */
  context_window: number;
  /** 最大输出 token；0 = 不限制 */
  max_tokens: number;
  /** 全局默认推理强度 */
  reasoning_effort: string;
  use_api_key: boolean;
};

/** 设置页初始草稿 / 兜底 */
export const DEFAULT_AI_CONFIG_DRAFT: AiConfigDraft = {
  account_id: 'default',
  account_name: '默认',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  models: ['gpt-4o-mini'],
  enabled_models: ['gpt-4o-mini'],
  api_format: 'openai',
  context_window: 0,
  max_tokens: 0,
  reasoning_effort: 'none',
  use_api_key: true,
};

export const AI_API_FORMAT_OPTIONS: readonly SelectOption<AiApiFormat>[] = [
  { value: 'openai', label: 'OpenAI', description: 'chat/completions' },
  { value: 'claude', label: 'Claude', description: 'Anthropic messages' },
] as const;

/** 与 Rust 侧 ai_config.rs 的边界常量保持一致 */
export const MIN_AI_CONTEXT_WINDOW = 1_000;
export const MAX_AI_CONTEXT_WINDOW = 2_000_000;
export const MAX_AI_OUTPUT_TOKENS = 1_000_000;
/**
 * 留空（0）时实际生效的上下文窗口。
 * 依据 2026 主流旗舰模型：GPT-5.x 全线 400K，Claude 4.5 为 200K（Sonnet 可扩 1M），Gemini 系 ~1M。
 */
export const AI_DEFAULT_CONTEXT_WINDOW = 200_000;

export const AI_REASONING_EFFORT_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'none', label: '默认', description: '请求不带推理强度' },
  { value: 'minimal', label: '最低', description: 'Minimal' },
  { value: 'low', label: '低', description: 'Low' },
  { value: 'medium', label: '中', description: 'Medium' },
  { value: 'high', label: '高', description: 'High' },
  { value: 'xhigh', label: '最高', description: 'Extra High' },
] as const;

export function normalizeAiApiFormat(raw?: string | null): AiApiFormat {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'claude' || value === 'anthropic') return 'claude';
  return 'openai';
}

/** 上下文窗口：<=0（留空）保持 0 = 未设置，运行时用 AI_DEFAULT_CONTEXT_WINDOW */
export function normalizeAiContextWindow(value?: number | null): number {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next <= 0) return 0;
  if (next < MIN_AI_CONTEXT_WINDOW) return MIN_AI_CONTEXT_WINDOW;
  if (next > MAX_AI_CONTEXT_WINDOW) return MAX_AI_CONTEXT_WINDOW;
  return next;
}

/** 实际生效的上下文窗口：留空时回落默认值 */
export function resolveAiEffectiveContextWindow(value?: number | null): number {
  const next = normalizeAiContextWindow(value);
  return next > 0 ? next : AI_DEFAULT_CONTEXT_WINDOW;
}

/** 最大输出 token：<=0（留空）保持 0 = 未设置（请求不注入，交由服务端按模型上限） */
export function normalizeAiMaxTokens(value?: number | null): number {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next) || next <= 0) return 0;
  return Math.min(next, MAX_AI_OUTPUT_TOKENS);
}

/** 测试耗时展示：<1s 用 ms，否则用 s */
export function formatAiTestDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 在模型列表中解析「用于测试」的当前选择 */
export function resolveAiTestModel(models: string[], preferred: string, fallback: string): string {
  const list = models.map((item) => item.trim()).filter(Boolean);
  const pick = preferred.trim();
  if (pick && list.includes(pick)) return pick;
  const fb = fallback.trim();
  if (fb && list.includes(fb)) return fb;
  return list[0] || pick || fb || '';
}

export type AiProviderTestLogPhase = 'start' | 'success' | 'error';

/** 连通性测试弹窗日志：模型 / 接口 / 首字 / 总耗时 / 回复 */
export function buildAiProviderTestLog(input: {
  phase: AiProviderTestLogPhase;
  model: string;
  baseUrl: string;
  apiFormat: string;
  content?: string;
  ttftMs?: number | null;
  totalMs?: number | null;
  error?: string;
}): string[] {
  const formatLabel = input.apiFormat.trim().toLowerCase() === 'claude' ? 'claude' : 'openai';
  const lines = [
    `模型：${input.model}`,
    `接口：${input.baseUrl}`,
    `格式：${formatLabel}`,
  ];
  if (input.phase === 'start') {
    return [...lines, '状态：请求中…'];
  }
  if (input.phase === 'error') {
    const out = [...lines, '状态：失败'];
    if (input.totalMs != null) out.push(`总耗时：${formatAiTestDurationMs(input.totalMs)}`);
    out.push(`错误：${(input.error ?? '未知错误').trim() || '未知错误'}`);
    return out;
  }
  return [
    ...lines,
    '状态：成功',
    `首字响应：${formatAiTestDurationMs(input.ttftMs)}`,
    `总耗时：${formatAiTestDurationMs(input.totalMs)}`,
    '回复：',
    (input.content ?? '').trim() || '(空)',
  ];
}

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
  if ((draft.account_id || '').trim() !== (saved.account_id || saved.active_account_id || '').trim()) return true;
  if ((draft.account_name || '').trim() !== (saved.account_name || '').trim()) return true;
  if (draft.base_url.trim() !== saved.base_url.trim()) return true;
  if (normalizeAiApiFormat(draft.api_format) !== normalizeAiApiFormat(saved.api_format)) return true;
  if (draftCatalog.model !== savedCatalog.model) return true;
  if (draftCatalog.models.join('\0') !== savedCatalog.models.join('\0')) return true;
  if (draftCatalog.enabled_models.join('\0') !== savedCatalog.enabled_models.join('\0')) return true;
  if (normalizeAiContextWindow(draft.context_window) !== normalizeAiContextWindow(saved.context_window)) return true;
  if (normalizeAiMaxTokens(draft.max_tokens) !== normalizeAiMaxTokens(saved.max_tokens)) return true;
  if (normalizeAiReasoningEffort(draft.reasoning_effort ?? 'none') !== normalizeAiReasoningEffort(saved.reasoning_effort)) return true;
  return false;
}

/** 从后端配置填充设置草稿（当前激活账号） */
export function aiConfigToDraft(config: AiProviderConfig): AiConfigDraft {
  const catalog = resolveAiModelCatalog(config);
  return {
    account_id: config.account_id || config.active_account_id || '',
    account_name: (config.account_name || '默认').trim() || '默认',
    base_url: config.base_url,
    model: catalog.model,
    models: catalog.models,
    enabled_models: catalog.enabled_models,
    api_format: normalizeAiApiFormat(config.api_format),
    context_window: normalizeAiContextWindow(config.context_window),
    max_tokens: normalizeAiMaxTokens(config.max_tokens),
    reasoning_effort: normalizeAiReasoningEffort(config.reasoning_effort),
    use_api_key: true,
  };
}

/**
 * 设置页 provider 状态：保留多账号摘要，不长期挂明文密钥。
 * （api_key 只进草稿 input）
 */
export function aiConfigToProviderState(config: AiProviderConfig): AiProviderConfig {
  const catalog = resolveAiModelCatalog(config);
  const accountId = (config.account_id || config.active_account_id || '').trim();
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];
  return {
    account_id: accountId,
    account_name: (config.account_name || '默认').trim() || '默认',
    base_url: config.base_url,
    model: catalog.model,
    models: catalog.models,
    enabled_models: catalog.enabled_models,
    reasoning_effort: normalizeAiReasoningEffort(config.reasoning_effort),
    api_format: normalizeAiApiFormat(config.api_format),
    context_window: normalizeAiContextWindow(config.context_window),
    max_tokens: normalizeAiMaxTokens(config.max_tokens),
    use_api_key: true,
    api_key_configured: Boolean(config.api_key_configured),
    api_key: null,
    accounts,
    active_account_id: (config.active_account_id || accountId).trim(),
    error: config.error ?? null,
  };
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
