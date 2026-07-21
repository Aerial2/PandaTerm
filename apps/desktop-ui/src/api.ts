import { invoke } from '@tauri-apps/api/core';
import {
  readText as readNativeClipboardText,
  writeText as writeNativeClipboardText,
} from '@tauri-apps/plugin-clipboard-manager';

export async function readClipboardText(): Promise<string> {
  return (await readNativeClipboardText()) ?? '';
}

export async function writeClipboardText(text: string): Promise<void> {
  await writeNativeClipboardText(text);
}

type ConnectionWindowMode = 'manage' | 'create';

function connectionWindowLabel(mode: ConnectionWindowMode) {
  return mode === 'create' ? 'connection-create' : 'connection-panel';
}

function connectionWindowUrl(mode: ConnectionWindowMode, warm = false) {
  const connectionMode = `connectionMode=${mode}`;
  const warmQuery = warm ? '&warm=1' : '';
  return import.meta.env.DEV
    ? `http://localhost:1420?mode=connection&${connectionMode}${warmQuery}`
    : `index.html?mode=connection&${connectionMode}${warmQuery}`;
}

async function getWebviewWindowApi() {
  return import('@tauri-apps/api/webviewWindow');
}

async function focusConnectionWindow(
  win: { emit: (event: string, payload: unknown) => Promise<void>; show: () => Promise<void>; unminimize: () => Promise<void>; setFocus: () => Promise<void> },
  mode: ConnectionWindowMode,
  label: string,
) {
  await win.emit('connection-window-set-mode', { mode, target: label });
  await win.show();
  await win.unminimize().catch(() => undefined);
  await win.setFocus();
}

async function resolveParentCenteredPosition(width: number, height: number) {
  try {
    const { getCurrentWebviewWindow } = await getWebviewWindowApi();
    const parent = getCurrentWebviewWindow();
    const [scale, parentPos, parentSize] = await Promise.all([
      parent.scaleFactor(),
      parent.outerPosition(),
      parent.outerSize(),
    ]);
    return {
      x: Math.round(parentPos.x / scale + (parentSize.width / scale - width) / 2),
      y: Math.round(parentPos.y / scale + (parentSize.height / scale - height) / 2),
    } as const;
  } catch {
    return { center: true } as const;
  }
}

/**
 * 空闲时预热连接窗口（隐藏挂起），避免首次点击冷启动整页 Webview。
 */
export function preloadConnectionWindows() {
  const run = () => {
    void getWebviewWindowApi();
    void import('./ConnectionWindow');
    void import('./AiSettingsWindow');
    void warmConnectionWindow('manage').catch(() => undefined);
    void warmAiSettingsWindow().catch(() => undefined);
  };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => run(), { timeout: 2500 });
    return;
  }
  globalThis.setTimeout(run, 1800);
}

async function warmConnectionWindow(mode: ConnectionWindowMode) {
  const { WebviewWindow } = await getWebviewWindowApi();
  const label = connectionWindowLabel(mode);
  if (await WebviewWindow.getByLabel(label)) return;

  const creatingKey = mode === 'create' ? '__pandatermConnCreateWarm' : '__pandatermConnManageWarm';
  const globalAny = globalThis as typeof globalThis & { [key: string]: Promise<void> | undefined };
  if (globalAny[creatingKey]) {
    await globalAny[creatingKey];
    return;
  }

  const windowOpts =
    mode === 'create'
      ? { width: 640, height: 520, minWidth: 520, minHeight: 420 }
      : { width: 880, height: 560, minWidth: 720, minHeight: 480 };

  globalAny[creatingKey] = (async () => {
    const position = await resolveParentCenteredPosition(windowOpts.width, windowOpts.height);
    // warm=1：页面不主动 show，保持隐藏挂起
    new WebviewWindow(label, {
      url: connectionWindowUrl(mode, true),
      title: mode === 'create' ? '新建连接 — PandaTerm' : '连接管理 — PandaTerm',
      ...windowOpts,
      ...('x' in position ? position : { center: true }),
      resizable: true,
      decorations: false,
      transparent: false,
      visible: false,
      backgroundColor: '#1e2227',
    });
  })();

  try {
    await globalAny[creatingKey];
  } finally {
    globalAny[creatingKey] = undefined;
  }
}

export async function openConnectionWindow(mode: ConnectionWindowMode) {
  const { WebviewWindow } = await getWebviewWindowApi();
  const label = connectionWindowLabel(mode);
  const warmKey = mode === 'create' ? '__pandatermConnCreateWarm' : '__pandatermConnManageWarm';
  const creatingKey = mode === 'create' ? '__pandatermConnCreateCreating' : '__pandatermConnManageCreating';
  const globalAny = globalThis as typeof globalThis & { [key: string]: Promise<void> | undefined };

  // 等待预热/创建中的实例，避免并发双开
  if (globalAny[warmKey]) await globalAny[warmKey].catch(() => undefined);
  if (globalAny[creatingKey]) {
    await globalAny[creatingKey].catch(() => undefined);
    const retryAfterCreate = await WebviewWindow.getByLabel(label);
    if (retryAfterCreate) {
      await focusConnectionWindow(retryAfterCreate, mode, label);
      return;
    }
  }

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await focusConnectionWindow(existing, mode, label);
    return;
  }

  const windowOpts =
    mode === 'create'
      ? { width: 640, height: 520, minWidth: 520, minHeight: 420 }
      : { width: 880, height: 560, minWidth: 720, minHeight: 480 };

  globalAny[creatingKey] = (async () => {
    const position = await resolveParentCenteredPosition(windowOpts.width, windowOpts.height);
    const connectionWindow = new WebviewWindow(label, {
      url: connectionWindowUrl(mode, false),
      title: mode === 'create' ? '新建连接 — PandaTerm' : '连接管理 — PandaTerm',
      ...windowOpts,
      ...('x' in position ? position : { center: true }),
      resizable: true,
      decorations: false,
      transparent: false,
      visible: false,
      backgroundColor: '#1e2227',
    });

    connectionWindow.once('tauri://error', (e) => {
      console.error('Connection window error:', e);
    });

    // 窗口进程创建后立刻显示，不等 React 首屏
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      connectionWindow.once('tauri://created', done);
      window.setTimeout(done, 1200);
    });

    await connectionWindow.show().catch(() => undefined);
    await connectionWindow.setFocus().catch(() => undefined);
    await connectionWindow.emit('connection-window-set-mode', { mode, target: label }).catch(() => undefined);
  })();

  try {
    await globalAny[creatingKey];
  } finally {
    globalAny[creatingKey] = undefined;
  }
}

export async function openAiSettingsWindow(tab: 'models' | 'mcp' = 'models') {
  const { WebviewWindow } = await getWebviewWindowApi();
  const label = 'ai-settings';
  const warmKey = '__pandatermAiSettingsWarm';
  const creatingKey = '__pandatermAiSettingsCreating';
  const globalAny = globalThis as typeof globalThis & { [key: string]: Promise<void> | undefined };

  if (globalAny[warmKey]) await globalAny[warmKey].catch(() => undefined);
  if (globalAny[creatingKey]) {
    await globalAny[creatingKey].catch(() => undefined);
    const retryAfterCreate = await WebviewWindow.getByLabel(label);
    if (retryAfterCreate) {
      await focusAiSettingsWindow(retryAfterCreate, tab);
      return;
    }
  }

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await focusAiSettingsWindow(existing, tab);
    return;
  }

  const windowOpts = { width: 980, height: 700, minWidth: 760, minHeight: 520 };

  globalAny[creatingKey] = (async () => {
    const position = await resolveParentCenteredPosition(windowOpts.width, windowOpts.height);
    const settingsWindow = new WebviewWindow(label, {
      url: aiSettingsWindowUrl(tab, false),
      title: 'AI 设置 — PandaTerm',
      ...windowOpts,
      ...('x' in position ? position : { center: true }),
      resizable: true,
      decorations: false,
      transparent: false,
      visible: false,
      backgroundColor: '#1D2025',
    });

    settingsWindow.once('tauri://error', (event) => {
      console.error('AI settings window error:', event);
    });

    // 窗口进程创建后立刻显示，不等 React 首屏（与连接窗口一致）
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      settingsWindow.once('tauri://created', done);
      window.setTimeout(done, 1200);
    });

    await settingsWindow.show().catch(() => undefined);
    await settingsWindow.setFocus().catch(() => undefined);
    await settingsWindow.emit('ai-settings-set-tab', { tab }).catch(() => undefined);
  })();

  try {
    await globalAny[creatingKey];
  } finally {
    globalAny[creatingKey] = undefined;
  }
}

async function focusAiSettingsWindow(
  win: { emit: (event: string, payload: unknown) => Promise<void>; show: () => Promise<void>; unminimize: () => Promise<void>; setFocus: () => Promise<void> },
  tab: 'models' | 'mcp',
) {
  await win.emit('ai-settings-set-tab', { tab });
  await win.show();
  await win.unminimize().catch(() => undefined);
  await win.setFocus();
}

function aiSettingsWindowUrl(tab: 'models' | 'mcp', warm = false) {
  const warmQuery = warm ? '&warm=1' : '';
  const query = `mode=ai-settings&tab=${tab}${warmQuery}`;
  return import.meta.env.DEV
    ? `http://localhost:1420?${query}`
    : `index.html?${query}`;
}

async function warmAiSettingsWindow() {
  const { WebviewWindow } = await getWebviewWindowApi();
  const label = 'ai-settings';
  if (await WebviewWindow.getByLabel(label)) return;

  const warmKey = '__pandatermAiSettingsWarm';
  const globalAny = globalThis as typeof globalThis & { [key: string]: Promise<void> | undefined };
  if (globalAny[warmKey]) {
    await globalAny[warmKey];
    return;
  }

  const windowOpts = { width: 980, height: 700, minWidth: 760, minHeight: 520 };
  globalAny[warmKey] = (async () => {
    const position = await resolveParentCenteredPosition(windowOpts.width, windowOpts.height);
    new WebviewWindow(label, {
      url: aiSettingsWindowUrl('models', true),
      title: 'AI 设置 — PandaTerm',
      ...windowOpts,
      ...('x' in position ? position : { center: true }),
      resizable: true,
      decorations: false,
      transparent: false,
      visible: false,
      backgroundColor: '#1D2025',
    });
  })();

  try {
    await globalAny[warmKey];
  } finally {
    globalAny[warmKey] = undefined;
  }
}

export type AuthType =
  | { type: 'password'; secret_id: string }
  | { type: 'private_key'; key_id: string; passphrase_secret_id?: string | null }
  | { type: 'keyboard_interactive'; response_secret_id: string }
  | { type: 'gssapi'; principal?: string | null }
  | { type: 'agent' };

export type Session = {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: AuthType;
  tags: string[];
  last_connected_at?: string | null;
  reconnect: {
    enabled: boolean;
    max_attempts: number;
    delay_ms: number;
  };
};

export type TerminalEvent = {
  session_id: string;
  kind: 'connected' | 'output' | 'error' | 'disconnected';
  payload: string;
};

export type LocalTerminalWriteResponse = {
  event: TerminalEvent;
  cwd?: string | null;
  prompt: string;
  clear: boolean;
};

export type LocalDirectoryEntry = {
  name: string;
  path: string;
  entry_type: 'directory' | 'file';
  size: number;
  modified_ms?: number | null;
};

export type LocalDirectoryListing = {
  path: string;
  parent?: string | null;
  entries: LocalDirectoryEntry[];
};

export type LocalFilePreview = {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
};

export type LocalTerminalProfile = {
  terminal_id: string;
  os: string;
  shell_name: string;
  cwd: string;
  prompt: string;
  banner: string[];
};

export type TerminalOutputEvent = {
  terminal_id: string;
  payload: string;
};

export type TerminalStatusEvent = {
  terminal_id: string;
  transport: 'local' | 'remote';
  state: 'connected' | 'failed' | 'disconnected';
  reason?: string | null;
};

const fallbackLocalTerminalProfile: LocalTerminalProfile = {
  terminal_id: '',
  os: navigator.platform.toLowerCase().includes('mac') ? 'macos' : 'windows',
  shell_name: navigator.platform.toLowerCase().includes('mac') ? 'zsh' : 'PowerShell',
  cwd: navigator.platform.toLowerCase().includes('mac') ? '/Users' : 'E:\\Project\\Rust\\PandaTerm',
  prompt: navigator.platform.toLowerCase().includes('mac') ? '/Users $' : 'PS E:\\Project\\Rust\\PandaTerm>',
  banner: [],
};

export async function listLocalDirectory(path?: string | null): Promise<LocalDirectoryListing> {
  return await invoke<LocalDirectoryListing>('list_local_directory', { path: path ?? null });
}

export async function readLocalFilePreview(path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_local_file_preview', { path });
}

export async function getLocalTerminalProfile(): Promise<LocalTerminalProfile> {
  return await invoke<LocalTerminalProfile>('local_terminal_profile_command');
}

export async function startLocalTerminal(cwd?: string | null, cols?: number, rows?: number): Promise<LocalTerminalProfile> {
  return await invoke<LocalTerminalProfile>('local_terminal_start', {
    request: { cwd: cwd ?? null, cols: cols ?? null, rows: rows ?? null },
  });
}

export async function sendLocalTerminalInput(terminalId: string, data: string): Promise<void> {
  await invoke('local_terminal_input', { request: { terminal_id: terminalId, data } });
}

export async function resizeLocalTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await invoke('local_terminal_resize', { request: { terminal_id: terminalId, cols, rows } });
}

export async function stopLocalTerminal(terminalId: string): Promise<void> {
  await invoke('local_terminal_stop', { terminalId });
}

export async function localTerminalWrite(data: string, cwd?: string | null): Promise<LocalTerminalWriteResponse> {
  return await invoke<LocalTerminalWriteResponse>('local_terminal_write', {
    request: { data, cwd: cwd ?? null },
  });
}

export type CredentialProtectionMode = 'dpapi' | 'master_password';

export type CredentialStatus = {
  mode: CredentialProtectionMode;
  locked: boolean;
  credential_count: number;
  error?: string | null;
};

export async function listSessions(): Promise<Session[]> {
  return await invoke<Session[]>('list_sessions');
}

export async function saveSession(
  session: Session,
  secret?: string | null,
  passphrase?: string | null,
): Promise<Session[]> {
  return await invoke<Session[]>('save_session', {
    request: { session, secret: secret || null, passphrase: passphrase || null },
  });
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  return await invoke<CredentialStatus>('credential_status');
}

export async function unlockCredentials(masterPassword: string): Promise<CredentialStatus> {
  return await invoke<CredentialStatus>('unlock_credentials', { masterPassword });
}

export async function lockCredentials(): Promise<void> {
  await invoke('lock_credentials');
}

export async function setCredentialProtection(
  mode: CredentialProtectionMode,
  masterPassword?: string | null,
): Promise<CredentialStatus> {
  return await invoke<CredentialStatus>('set_credential_protection', {
    request: { mode, master_password: masterPassword || null },
  });
}

export type AiApiFormat = 'openai' | 'claude';

export type AiProviderAccountView = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_format: string;
  api_key_configured: boolean;
};

export type AiProviderConfig = {
  /** 当前激活账号 */
  account_id: string;
  account_name: string;
  base_url: string;
  model: string;
  models: string[];
  /** 聊天模型列表中可见的已选模型 */
  enabled_models: string[];
  /** OpenAI-compatible reasoning_effort；none 表示请求不带该字段 */
  reasoning_effort: string;
  /** 接口兼容格式：openai | claude */
  api_format: AiApiFormat | string;
  use_api_key: boolean;
  api_key_configured: boolean;
  /** 本机 vault 解密后的密钥；仅用于设置页回填展示 */
  api_key?: string | null;
  accounts: AiProviderAccountView[];
  active_account_id: string;
  error?: string | null;
};

export type AiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiChatResponse = {
  content: string;
  model: string;
};

export type AiChatStreamEvent = {
  request_id: string;
  kind: 'started' | 'delta' | 'completed' | 'cancelled' | 'error';
  delta?: string | null;
  model?: string | null;
  message?: string | null;
  /** Agent 模式流式结束后附带的 OpenAI tool_calls */
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }> | null;
};

export type AiStoredContext = {
  kind: 'terminal' | 'selection' | 'file';
  label: string;
  source?: string | null;
};

export type AiStoredEditAction = {
  kind: 'edit';
  id: string;
  summary: string;
  target_source: string;
  target_label: string;
  status: 'proposed' | 'reading' | 'ready' | 'applying' | 'applied' | 'rejected' | 'stale' | 'error';
  edits: Array<{ search: string; replace: string }>;
  is_remote: boolean;
  terminal_id?: string | null;
  error?: string | null;
  continued: boolean;
  created_at: string;
};

export type AiStoredTerminalAction = {
  kind: 'terminal';
  id: string;
  summary: string;
  context_source: string;
  context_label: string;
  command: string;
  timeout_ms: number;
  status: 'proposed' | 'running' | 'completed' | 'rejected' | 'timeout' | 'error';
  is_remote: boolean;
  terminal_id: string;
  output?: string | null;
  exit_code?: number | null;
  truncated: boolean;
  error?: string | null;
  continued: boolean;
  tool_call_id?: string | null;
  created_at: string;
};

export type AiStoredMcpAction = {
  kind: 'mcp';
  id: string;
  summary: string;
  server_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: 'proposed' | 'running' | 'completed' | 'rejected' | 'error';
  content?: string | null;
  is_error: boolean;
  error?: string | null;
  continued: boolean;
  tool_call_id?: string | null;
  created_at: string;
};

export type AiStoredAction = AiStoredEditAction | AiStoredTerminalAction | AiStoredMcpAction;

export type AiStoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contexts: AiStoredContext[];
  actions?: AiStoredAction[];
  created_at: string;
  status: 'complete' | 'cancelled' | 'error';
};

export type AiConversation = {
  id: string;
  title: string;
  mode: 'ask' | 'agent';
  created_at: string;
  updated_at: string;
  messages: AiStoredMessage[];
};

export type AiTerminalCommandResult = {
  output: string;
  exit_code?: number | null;
  truncated: boolean;
  timed_out: boolean;
};

export async function runAiTerminalCommand(request: {
  terminal_id: string;
  is_remote: boolean;
  command: string;
  timeout_ms: number;
}): Promise<AiTerminalCommandResult> {
  return await invoke<AiTerminalCommandResult>('run_ai_terminal_command', { request });
}

export async function getAiProviderConfig(): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('get_ai_provider_config');
}

export async function saveAiProviderConfig(
  config: Pick<AiProviderConfig, 'base_url' | 'model' | 'use_api_key'> & {
    account_id?: string;
    account_name?: string;
    models?: string[];
    enabled_models?: string[];
    reasoning_effort?: string;
    api_format?: string;
  },
  apiKey?: string | null,
): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('save_ai_provider_config', {
    request: {
      account_id: config.account_id ?? null,
      account_name: config.account_name ?? null,
      base_url: config.base_url,
      model: config.model,
      models: config.models ?? null,
      enabled_models: config.enabled_models ?? null,
      reasoning_effort: config.reasoning_effort ?? null,
      api_format: config.api_format ?? null,
      use_api_key: config.use_api_key,
      api_key: apiKey || null,
    },
  });
}

export async function addAiProviderAccount(): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('add_ai_provider_account');
}

export async function deleteAiProviderAccount(accountId: string): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('delete_ai_provider_account', {
    request: { account_id: accountId },
  });
}

export async function setActiveAiProviderAccount(accountId: string): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('set_active_ai_provider_account', {
    request: { account_id: accountId },
  });
}

export async function syncAiProviderModels(options?: {
  account_id?: string | null;
  base_url?: string | null;
  use_api_key?: boolean | null;
  api_key?: string | null;
  api_format?: string | null;
}): Promise<AiProviderConfig> {
  return await invoke<AiProviderConfig>('sync_ai_provider_models', {
    request: {
      account_id: options?.account_id ?? null,
      base_url: options?.base_url ?? null,
      use_api_key: options?.use_api_key ?? null,
      api_key: options?.api_key || null,
      api_format: options?.api_format ?? null,
    },
  });
}

export type AiProviderTestResult = {
  content: string;
  model: string;
  base_url: string;
  api_format: string;
  /** 发起 → HTTP 响应头 */
  connect_ms: number;
  /** 发起 → 首个文本 token */
  ttft_ms: number;
  /** 发起 → 完整结束 */
  total_ms: number;
};

/** 使用草稿配置流式探测连通性（不落盘；返回首字/总耗时） */
export async function testAiProvider(request: {
  base_url: string;
  model: string;
  api_format?: string | null;
  use_api_key?: boolean | null;
  api_key?: string | null;
}): Promise<AiProviderTestResult> {
  return await invoke<AiProviderTestResult>('test_ai_provider', {
    request: {
      base_url: request.base_url,
      model: request.model,
      api_format: request.api_format ?? null,
      use_api_key: request.use_api_key ?? true,
      api_key: request.api_key || null,
    },
  });
}

export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

export type McpToolInfo = {
  name: string;
  description: string;
  input_schema?: unknown;
};

export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** 取消勾选的工具名，不进入 Agent 且禁止调用 */
  disabled_tools?: string[];
};

export type McpServerSnapshot = McpServerConfig & {
  status: string;
  error?: string | null;
  tools: McpToolInfo[];
  tool_count: number;
};

export type McpConfigSnapshot = {
  servers: McpServerSnapshot[];
  error?: string | null;
  config_path?: string | null;
};

export type CallMcpToolResult = {
  content: string;
  is_error: boolean;
};

export async function getMcpConfig(): Promise<McpConfigSnapshot> {
  return await invoke<McpConfigSnapshot>('get_mcp_config');
}

export async function saveMcpConfig(servers: McpServerConfig[]): Promise<McpConfigSnapshot> {
  return await invoke<McpConfigSnapshot>('save_mcp_config', {
    request: { servers },
  });
}

export async function reconnectMcpServer(serverId: string): Promise<McpConfigSnapshot> {
  return await invoke<McpConfigSnapshot>('reconnect_mcp_server', { serverId });
}

export async function listMcpTools(): Promise<Array<{
  server: string;
  server_name: string;
  tool: string;
  description: string;
  input_schema?: unknown;
}>> {
  return await invoke('list_mcp_tools');
}

export async function callMcpTool(request: {
  server_id: string;
  tool_name: string;
  arguments?: Record<string, unknown> | null;
}): Promise<CallMcpToolResult> {
  return await invoke<CallMcpToolResult>('call_mcp_tool', { request });
}

export type McpImportCandidate = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  server_count?: number | null;
  error?: string | null;
};

export type McpImportPreview = {
  path: string;
  servers: McpServerConfig[];
  server_count: number;
};

/** 探测 Cursor / Claude 等常见 MCP 配置路径 */
export async function listMcpImportCandidates(): Promise<McpImportCandidate[]> {
  return await invoke<McpImportCandidate[]>('list_mcp_import_candidates');
}

/** 从路径解析 MCP 服务器（不落盘） */
export async function importMcpServersFromPath(path: string): Promise<McpImportPreview> {
  return await invoke<McpImportPreview>('import_mcp_servers_from_path', { path });
}

/** 导出 Cursor 风格 mcpServers JSON 文本（不落盘） */
export async function exportMcpServersCursorJson(servers: McpServerConfig[]): Promise<string> {
  return await invoke<string>('export_mcp_servers_cursor_json', { servers });
}

export async function sendAiChat(messages: AiChatMessage[]): Promise<AiChatResponse> {
  return await invoke<AiChatResponse>('ai_chat', { request: { messages } });
}

export async function streamAiChat(
  requestId: string,
  messages: AiChatMessage[],
  mode?: 'ask' | 'agent' | null,
): Promise<void> {
  await invoke('ai_chat_stream', {
    request: {
      request_id: requestId,
      messages,
      mode: mode ?? null,
    },
  });
}

export async function stopAiChat(requestId: string): Promise<void> {
  await invoke('stop_ai_chat', { requestId });
}

export async function listAiConversations(): Promise<AiConversation[]> {
  return await invoke<AiConversation[]>('list_ai_conversations');
}

export async function saveAiConversation(conversation: AiConversation): Promise<AiConversation[]> {
  return await invoke<AiConversation[]>('save_ai_conversation', { conversation });
}

export async function deleteAiConversation(conversationId: string): Promise<AiConversation[]> {
  return await invoke<AiConversation[]>('delete_ai_conversation', { conversationId });
}

export async function deleteSession(sessionId: string): Promise<Session[]> {
  return await invoke<Session[]>('delete_session', { sessionId });
}

export async function reorderSessions(orderedIds: string[]): Promise<Session[]> {
  return await invoke<Session[]>('reorder_sessions', { orderedIds });
}

export async function connectSession(sessionId: string, terminalId: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('connect_session', { sessionId, terminalId });
}

export async function disconnectSession(terminalId: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('disconnect_session', { terminalId });
}

export async function terminalWrite(terminalId: string, data: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('terminal_write', {
    request: { terminal_id: terminalId, data },
  });
}

export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await invoke('terminal_resize', { request: { terminal_id: terminalId, cols, rows } });
}

export async function listRemoteDirectory(terminalId: string, path?: string | null): Promise<LocalDirectoryListing> {
  return await invoke<LocalDirectoryListing>('list_remote_directory', { terminalId, path: path ?? null });
}

export async function readRemoteFilePreview(terminalId: string, path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_remote_file_preview', { terminalId, path });
}

export async function readLocalFileFull(path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_local_file_full', { path });
}

export async function readRemoteFileFull(
  terminalId: string,
  path: string,
  transferId?: string | null,
): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_remote_file_full', {
    terminalId,
    path,
    transferId: transferId ?? null,
  });
}

export async function writeLocalFileChecked(path: string, expectedContent: string, content: string): Promise<void> {
  await invoke('write_local_file_checked', { path, expectedContent, content });
}

export async function writeRemoteFileChecked(
  terminalId: string,
  path: string,
  expectedContent: string,
  content: string,
): Promise<void> {
  await invoke('write_remote_file_checked', { terminalId, path, expectedContent, content });
}

export async function writeLocalFile(path: string, content: string): Promise<void> {
  await invoke('write_local_file', { path, content });
}

export async function writeRemoteFile(terminalId: string, path: string, content: string): Promise<void> {
  await invoke('write_remote_file', { terminalId, path, content });
}

export async function uploadFile(fileName: string, content: Uint8Array, destDir: string, transferId: string, terminalId?: string | null): Promise<string> {
  // Encode as base64 to avoid Tauri IPC corruption with large binary arrays.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < content.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(content.subarray(i, i + chunkSize)));
  }
  const contentBase64 = btoa(binary);
  return await invoke<string>('upload_file', {
    terminalId: terminalId ?? null,
    fileName,
    contentBase64,
    destDir,
    transferId,
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  await invoke('cancel_transfer', { transferId });
}

/// Stream-upload a local file to a remote directory. The Rust backend reads
/// the file in chunks and pipes it through SSH, so we avoid base64-encoding
/// large files on the JS side (which blocks the UI and freezes progress).
/// Only works for remote uploads (requires a connected terminalId).
export async function uploadLocalFile(
  localPath: string,
  destDir: string,
  transferId: string,
  terminalId: string,
  remoteName?: string,
): Promise<string> {
  return await invoke<string>('upload_local_file', {
    terminalId,
    localPath,
    destDir,
    transferId,
    remoteName: remoteName ?? null,
  });
}

export type UploadDirectoryResult = {
  remote_path: string;
  files_uploaded: number;
  dirs_created: number;
  total_bytes: number;
  failed_items: string[];
};

/// Recursively upload a local directory to a remote server.
/// Creates directory structure on remote and uploads all files.
export async function uploadDirectory(localDir: string, destDir: string, terminalId: string, transferId: string): Promise<UploadDirectoryResult> {
  return await invoke<UploadDirectoryResult>('upload_directory', {
    terminalId,
    localDir,
    destDir,
    transferId,
  });
}

export async function readFileAsDataUrl(path: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('read_file_as_data_url', {
    terminalId: terminalId ?? null,
    path,
  });
}

export async function downloadRemoteFile(terminalId: string, remotePath: string, transferId: string): Promise<string> {
  return await invoke<string>('download_remote_file', { terminalId, remotePath, transferId });
}

export async function extractArchive(archivePath: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('extract_archive', {
    terminalId: terminalId ?? null,
    archivePath,
  });
}

export async function createArchive(sourcePath: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('create_archive', {
    terminalId: terminalId ?? null,
    sourcePath,
  });
}

export async function deletePath(path: string, terminalId?: string | null): Promise<void> {
  await invoke('delete_path', { terminalId: terminalId ?? null, path });
}

export async function createFile(path: string, terminalId?: string | null): Promise<void> {
  await invoke('create_file', { terminalId: terminalId ?? null, path });
}

export async function createDirectory(path: string, terminalId?: string | null): Promise<void> {
  await invoke('create_directory', { terminalId: terminalId ?? null, path });
}

export async function copyPath(source: string, destDir: string, terminalId?: string | null, destName?: string): Promise<string> {
  return await invoke<string>('copy_path', { terminalId: terminalId ?? null, source, destDir, destName: destName ?? null });
}

export async function movePath(source: string, destDir: string, terminalId?: string | null, destName?: string): Promise<string> {
  return await invoke<string>('move_path', { terminalId: terminalId ?? null, source, destDir, destName: destName ?? null });
}

export async function getLocalIpv4(): Promise<string> {
  return await invoke<string>('get_local_ipv4');
}

/// Suggested upload concurrency for the local machine (1 if CPU is busy,
/// 2 otherwise). Used to size the front-end upload worker pool.
export async function getUploadConcurrency(): Promise<number> {
  return await invoke<number>('get_upload_concurrency');
}

export interface SystemMonitorData {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel_version: string;
  uptime_seconds: number;
  cpu_count: number;
  cpu_usage_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_available_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_available_bytes: number;
  load_avg_1min: number;
  load_avg_5min: number;
  load_avg_15min: number;
  cpu_model: string;
  network_rx_bytes: number;
  network_tx_bytes: number;
  processes: number;
}

export async function getSystemMonitor(terminalId?: string | null): Promise<SystemMonitorData> {
  return await invoke<SystemMonitorData>('get_system_monitor', { terminalId: terminalId ?? null });
}

export interface ProcessInfo {
  pid: number;
  name: string;
  status: string;
  cpu_usage_percent: number;
  memory_bytes: number;
  disk_bytes_per_sec: number;
  network_bytes_per_sec: number;
}

export async function getProcessList(terminalId?: string | null): Promise<ProcessInfo[]> {
  return await invoke<ProcessInfo[]>('get_process_list', { terminalId: terminalId ?? null });
}
