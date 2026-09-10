#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod about;
mod ai_config;
mod archive;
mod base64;
mod credential;
mod known_hosts;
mod legacy_secret;
mod local_fs;
mod local_shell;
mod mcp;
mod rdp;
mod session_store;
mod shell_text;
mod sse;
mod storage;
mod system_monitor;
mod xshell;

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use ai_config::{
    ai_chat_endpoint, ai_models_url, ai_request_max_tokens, ai_request_reasoning_effort,
    find_ai_account, find_ai_account_mut, is_claude_api_format, load_ai_config, merge_ai_models,
    normalize_ai_account_name, normalize_ai_config_store, normalize_ai_models,
    normalize_enabled_ai_models, save_ai_config, validate_ai_api_format, validate_ai_base_url,
    validate_ai_context_window, validate_ai_max_tokens, validate_ai_model,
    validate_ai_reasoning_effort, AiProviderAccountStore, AiProviderConfigStore,
    AI_CLAUDE_FALLBACK_MAX_TOKENS, AI_CONFIG_VERSION, DEFAULT_AI_API_FORMAT, DEFAULT_AI_BASE_URL,
    DEFAULT_AI_CONTEXT_WINDOW, DEFAULT_AI_MAX_TOKENS, DEFAULT_AI_MODEL, MAX_AI_ACCOUNTS,
    MAX_AI_MODELS,
};
use archive::{extract_command, extract_local_archive};
use base64::{base64_decode, base64_encode};
use local_fs::{default_local_path, format_path, parse_remote_listing, resolve_local_path, LocalDirectoryListing, LocalFilePreview, LOCAL_FILE_FULL_LIMIT};
use local_shell::{
    is_clear_command, local_prompt, local_pty_command, local_pty_size, local_shell_name,
    run_local_shell_command,
};
use shell_text::StreamDecoder;
use panda_core::{TerminalEvent, TerminalEventKind};
use panda_crypto::{protect_secret, unprotect_secret, ProtectionMode, SecretError};
use panda_session::{AuthType, Session, SessionCatalog};
use credential::{
    credential_context, credential_id, credential_status_snapshot, ensure_vault_available,
    resolve_credential, save_credential_vault,
    store_credential, vault_master_password, CredentialProtectionRequest, CredentialStatus,
    CredentialVault, CredentialVaultState, CREDENTIAL_VAULT_VERSION, CREDENTIAL_VERIFIER_CONTEXT,
    CREDENTIAL_VERIFIER_VALUE,
};
use known_hosts::{check_fingerprint, trust_fingerprint, FingerprintCheck};
use session_store::{
    load_secure_state, migrate_legacy_credentials, resolved_session, save_persistent_sessions,
};
use storage::{
    ai_conversations_path, atomic_write_bytes, atomic_write_text, pandaterm_data_dir,
};
use sse::{sse_data, take_sse_events};
use system_monitor::{ProcessInfo, SystemMonitorData};
use portable_pty::{native_pty_system, Child, MasterPty};
use reqwest::{redirect::Policy, Client};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(target_os = "windows")]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        attribute: u32,
        pvattribute: *const std::ffi::c_void,
        cbattribute: u32,
    ) -> i32;
}

struct TransferCancellationEntry {
    signal: Arc<AtomicBool>,
    registered: bool,
}

struct AiGenerationEntry {
    signal: Arc<AtomicBool>,
    notification: Arc<Notify>,
}

/// 非流式 AI 请求的整体上限。
const AI_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// 流式响应相邻数据块之间的最大空闲时间。流式回答不设总时长——
/// 长回答经常超过 2 分钟，若用整体超时会必然在中途断流。
const AI_STREAM_CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(180);
/// 主机指纹首信需要用户阅读并确认，不能使用过短的握手总超时。
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(120);

struct AppState {
    sessions: Mutex<SessionCatalog>,
    session_store_error: Mutex<Option<String>>,
    credentials: Mutex<CredentialVaultState>,
    ai_config: Mutex<AiProviderConfigStore>,
    ai_config_error: Mutex<Option<String>>,
    ai_conversations: Mutex<AiConversationStore>,
    ai_conversation_error: Mutex<Option<String>>,
    ai_generations: Mutex<HashMap<String, AiGenerationEntry>>,
    ai_http: Client,
    mcp_config: Mutex<mcp::McpConfigStore>,
    mcp_config_error: Mutex<Option<String>>,
    mcp_runtime: Arc<mcp::McpRuntime>,
    local_terminals: Mutex<HashMap<Uuid, LocalTerminalSession>>,
    remote_terminals: Mutex<HashMap<Uuid, RemoteTerminalSession>>,
    /// RDP 图形会话（keyed by 前端 terminal id），持关闭标志用于优雅断开。
    rdp_terminals: Mutex<HashMap<Uuid, rdp::RdpSession>>,
    /// Reused SSH handles for file transfer (keyed by interactive terminal id).
    transfer_handles: Mutex<HashMap<Uuid, SharedRemoteHandle>>,
    /// Transfer cancellation state keyed by the frontend transfer id.
    transfer_cancellations: Mutex<HashMap<String, TransferCancellationEntry>>,
    /// Cached sysinfo::System for local CPU usage monitoring.
    /// Keeps CPU time counters alive so that `refresh_cpu_usage()` computes
    /// correct deltas between successive calls instead of starting from scratch.
    local_sys_monitor: std::sync::Mutex<Option<sysinfo::System>>,
    /// Serializes the one-time asynchronous CPU baseline sampling.
    local_sys_monitor_init: Mutex<()>,
}

type SharedWriter = Arc<std::sync::Mutex<Box<dyn Write + Send>>>;

struct LocalTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: Box<dyn Child + Send>,
}

type SharedRemoteHandle = Arc<russh::client::Handle<SshHandler>>;

struct RemoteTerminalSession {
    control: mpsc::Sender<RemoteTerminalCommand>,
    closed: Arc<AtomicBool>,
    close_notification: Arc<Notify>,
    handle: SharedRemoteHandle,
    session_id: Uuid,
}

enum RemoteTerminalCommand {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

const AI_API_KEY_PREFIX: &str = "credential:ai:openai-compatible:api-key";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_AI_MESSAGES: usize = 100;
const MAX_AI_MESSAGE_CHARS: usize = 32_000;
const MAX_AI_TOTAL_CHARS: usize = 200_000;

/// 设置页账号列表项（不含密钥明文）
#[derive(Debug, Clone, Serialize)]
struct AiProviderAccountView {
    id: String,
    name: String,
    base_url: String,
    model: String,
    api_format: String,
    api_key_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AiProviderConfig {
    /// 当前激活账号
    account_id: String,
    account_name: String,
    base_url: String,
    model: String,
    models: Vec<String>,
    enabled_models: Vec<String>,
    reasoning_effort: String,
    api_format: String,
    /// 模型上下文窗口（token）
    context_window: u32,
    /// 最大输出 token；0 = 不限制
    max_tokens: u32,
    use_api_key: bool,
    api_key_configured: bool,
    api_key: Option<String>,
    /// 全部账号摘要（设置页切换）
    accounts: Vec<AiProviderAccountView>,
    active_account_id: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SaveAiProviderConfigRequest {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    account_name: Option<String>,
    base_url: String,
    model: String,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    enabled_models: Option<Vec<String>>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    api_format: Option<String>,
    #[serde(default)]
    context_window: Option<u32>,
    #[serde(default)]
    max_tokens: Option<u32>,
    use_api_key: bool,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SyncAiModelsRequest {
    #[serde(default)]
    account_id: Option<String>,
    base_url: Option<String>,
    use_api_key: Option<bool>,
    api_key: Option<String>,
    #[serde(default)]
    api_format: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiAccountIdRequest {
    account_id: String,
}

/// 使用草稿配置发送一条测试消息（不落盘；流式以测量首字耗时）
#[derive(Debug, Clone, Deserialize)]
struct TestAiProviderRequest {
    base_url: String,
    model: String,
    #[serde(default)]
    api_format: Option<String>,
    #[serde(default)]
    use_api_key: Option<bool>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct TestAiProviderResponse {
    content: String,
    model: String,
    base_url: String,
    api_format: String,
    connect_ms: u64,
    ttft_ms: u64,
    total_ms: u64,
}

const AI_CONVERSATION_VERSION: u8 = 2;
const AI_CHAT_STREAM_EVENT: &str = "ai-chat-stream";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiConversationStore {
    version: u8,
    conversations: Vec<AiConversation>,
}

impl Default for AiConversationStore {
    fn default() -> Self {
        Self {
            version: AI_CONVERSATION_VERSION,
            conversations: Vec::new(),
        }
    }
}

fn default_ai_conversation_mode() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiConversation {
    id: String,
    title: String,
    #[serde(default = "default_ai_conversation_mode")]
    mode: String,
    created_at: String,
    updated_at: String,
    messages: Vec<AiStoredMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiStoredMessage {
    id: String,
    role: String,
    content: String,
    contexts: Vec<AiStoredContext>,
    #[serde(default)]
    actions: Vec<AiStoredAction>,
    created_at: String,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AiStoredAction {
    Edit {
        id: String,
        summary: String,
        target_source: String,
        target_label: String,
        status: String,
        edits: Vec<AiStoredEditOperation>,
        #[serde(default)]
        is_remote: bool,
        terminal_id: Option<String>,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        created_at: String,
    },
    Terminal {
        id: String,
        summary: String,
        context_source: String,
        context_label: String,
        command: String,
        timeout_ms: u64,
        status: String,
        is_remote: bool,
        terminal_id: String,
        output: Option<String>,
        exit_code: Option<i32>,
        #[serde(default)]
        truncated: bool,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        tool_call_id: Option<String>,
        created_at: String,
    },
    Mcp {
        id: String,
        summary: String,
        server_id: String,
        tool_name: String,
        #[serde(default)]
        arguments: Value,
        status: String,
        content: Option<String>,
        #[serde(default)]
        is_error: bool,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        tool_call_id: Option<String>,
        created_at: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiStoredEditOperation {
    search: String,
    replace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiStoredContext {
    kind: String,
    label: String,
    source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiChatStreamRequest {
    request_id: String,
    messages: Vec<AiChatMessage>,
    /// ask | agent；agent 模式注入 OpenAI-compatible tools
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiToolCall {
    id: String,
    name: String,
    /// 供应商返回的 function.arguments JSON 字符串（可能分片拼接）
    arguments: String,
}

#[derive(Debug, Clone, Serialize)]
struct AiChatStreamEvent {
    request_id: String,
    kind: String,
    delta: Option<String>,
    model: Option<String>,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<AiToolCall>>,
}

#[derive(Debug, Serialize)]
struct OpenAiChatStreamRequest<'a> {
    model: &'a str,
    messages: &'a [AiChatMessage],
    stream: bool,
    /// 0（未配置）时不注入，沿用服务端默认
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a [Value]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChunk {
    model: Option<String>,
    choices: Vec<OpenAiStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChoice {
    delta: OpenAiStreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamDelta {
    content: Option<Value>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiStreamToolCallDelta>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamToolCallDelta {
    index: usize,
    id: Option<String>,
    function: Option<OpenAiStreamFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamFunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Default)]
struct StreamToolCallBuilder {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AiChatRequest {
    messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
struct AiChatResponse {
    content: String,
    model: String,
}

#[derive(Debug, Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: &'a [AiChatMessage],
    /// 0（未配置）时不注入，沿用服务端默认
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    model: Option<String>,
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiResponseMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponseMessage {
    content: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct SaveSessionRequest {
    session: Session,
    secret: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalWriteRequest {
    terminal_id: Uuid,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalResizeRequest {
    terminal_id: Uuid,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalWriteRequest {
    data: String,
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalStartRequest {
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalInputRequest {
    terminal_id: Uuid,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalResizeRequest {
    terminal_id: Uuid,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TerminalOutputEvent {
    terminal_id: String,
    payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalWriteResponse {
    event: TerminalEvent,
    cwd: Option<String>,
    prompt: String,
    clear: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalTerminalProfile {
    terminal_id: String,
    os: String,
    shell_name: String,
    cwd: String,
    prompt: String,
    banner: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AiTerminalCommandRequest {
    terminal_id: String,
    is_remote: bool,
    command: String,
    timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct AiTerminalCommandResult {
    output: String,
    exit_code: Option<i32>,
    truncated: bool,
    timed_out: bool,
}


const REMOTE_FILE_FULL_LIMIT: u64 = 500 * 1024 * 1024;
const AI_TERMINAL_COMMAND_MAX_LENGTH: usize = 4_000;
const AI_TERMINAL_OUTPUT_LIMIT: usize = 64 * 1024;
const AI_TERMINAL_MIN_TIMEOUT_MS: u64 = 3_000;
const AI_TERMINAL_MAX_TIMEOUT_MS: u64 = 30_000;
const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";
const TERMINAL_STATUS_EVENT: &str = "terminal-status";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum TerminalTransport {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum TerminalLifecycleState {
    Connected,
    Failed,
    Disconnected,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalStatusEvent {
    terminal_id: String,
    transport: TerminalTransport,
    state: TerminalLifecycleState,
    reason: Option<String>,
}

fn emit_remote_log(_app: &AppHandle, terminal_id: &str, message: impl AsRef<str>) {
    eprintln!("[SSH {}] {}", terminal_id, message.as_ref());
}

fn emit_remote_ready(app: &AppHandle, terminal_id: &str) {
    emit_terminal_status(
        app,
        terminal_id,
        TerminalTransport::Remote,
        TerminalLifecycleState::Connected,
        None,
    );
}

fn mcp_config_file_path() -> Result<PathBuf, String> {
    Ok(mcp::mcp_config_path(&pandaterm_data_dir()?))
}

fn load_ai_conversations() -> Result<AiConversationStore, String> {
    let path = ai_conversations_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AiConversationStore::default());
        }
        Err(error) => return Err(format!("AI 会话记录读取失败：{error}")),
    };
    let mut store: AiConversationStore = serde_json::from_str(&content)
        .map_err(|error| format!("AI 会话记录已损坏，已拒绝覆盖原文件：{error}"))?;
    if store.version == 1 {
        store.version = AI_CONVERSATION_VERSION;
    } else if store.version != AI_CONVERSATION_VERSION {
        return Err(format!("不支持的 AI 会话记录版本：{}", store.version));
    }
    Ok(store)
}

fn save_ai_conversations(store: &AiConversationStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|error| format!("AI 会话记录序列化失败：{error}"))?;
    atomic_write_text(&ai_conversations_path()?, &content)
        .map_err(|error| format!("AI 会话记录保存失败：{error}"))
}

async fn ensure_session_store_available(state: &AppState) -> Result<(), String> {
    match &*state.session_store_error.lock().await {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

fn local_terminal_profile() -> LocalTerminalProfile {
    let cwd = default_local_path().unwrap_or_else(|_| PathBuf::from("."));
    LocalTerminalProfile {
        terminal_id: String::new(),
        os: std::env::consts::OS.to_string(),
        shell_name: local_shell_name().to_string(),
        cwd: format_path(cwd.clone()),
        prompt: local_prompt(&cwd),
        banner: Vec::new(),
    }
}

/// Format a host and port without making IPv6 addresses ambiguous.
pub(crate) fn format_host_port(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.starts_with('[') && host.ends_with(']') {
        format!("{host}:{port}")
    } else if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

struct SshHandler {
    app: AppHandle,
    host_port: String,
    /// Filled when host key verification fails so connect can surface a clear error.
    host_key_error: Arc<std::sync::Mutex<Option<String>>>,
}

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 首见指纹需要用户确认（原生对话框）：在阻塞线程弹窗，避免占死
        // 异步 worker；等待期间连接协程挂起，不会向服务器发送任何凭据。
        let app = self.app.clone();
        let host_port = self.host_port.clone();
        let fingerprint = known_hosts::ssh_server_fingerprint(server_public_key);
        let result =
            tokio::task::spawn_blocking(move || {
                ensure_host_key_trusted_blocking(&app, &host_port, &fingerprint, "SSH")
            })
            .await;
        match result {
            Ok(Ok(())) => Ok(true),
            Ok(Err(message)) => {
                if let Ok(mut slot) = self.host_key_error.lock() {
                    *slot = Some(message);
                }
                Ok(false)
            }
            Err(error) => {
                if let Ok(mut slot) = self.host_key_error.lock() {
                    *slot = Some(format!("主机指纹确认失败：{error}"));
                }
                Ok(false)
            }
        }
    }
}

/// SSH/RDP 共用的主机指纹确认（TOFU，但首见必须经用户同意）：
/// 已知且匹配 → 放行；未知 → 弹原生 Yes/No 对话框，同意后入库；
/// 指纹不匹配 → 直接报错拦截潜在 MITM。**必须在阻塞线程调用**——
/// 弹窗期间 RDP 在独立线程阻塞、SSH 走 spawn_blocking。
pub(crate) fn ensure_host_key_trusted_blocking(
    app: &AppHandle,
    host_port: &str,
    fingerprint: &str,
    label: &str,
) -> Result<(), String> {
    match check_fingerprint(host_port, fingerprint)? {
        FingerprintCheck::Trusted => return Ok(()),
        FingerprintCheck::Unknown => {}
    }
    let accepted = tauri_plugin_dialog::DialogExt::dialog(app)
        .message(format!(
            "未能识别 {label} 主机 {host_port} 的密钥。\n\n指纹：\n{fingerprint}\n\n是否信任并继续连接？\n\n首次连接存在中间人风险，建议与服务器管理员核对指纹。选择“否”将取消本次连接。",
        ))
        .title(format!("首次连接：确认 {label} 主机指纹"))
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNo)
        .blocking_show();
    if !accepted {
        eprintln!("[HostKey] user rejected first-seen key for {host_port}");
        return Err(format!(
            "已拒绝信任 {label} 主机 {host_port} 的首次指纹，连接已取消"
        ));
    }
    trust_fingerprint(host_port, fingerprint)?;
    emit_host_key_saved_log(app, label, host_port);
    Ok(())
}

fn emit_host_key_saved_log(_app: &AppHandle, label: &str, host_port: &str) {
    eprintln!("[HostKey] user accepted and stored key for {label} {host_port}");
}

async fn connect_russh_session(
    app: &AppHandle,
    terminal_id: &str,
    session: &Session,
) -> Result<russh::client::Handle<SshHandler>, String> {
    emit_remote_log(
        app,
        terminal_id,
        format!("Connecting to {}...", format_host_port(&session.host, session.port)),
    );

    let config = Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        window_size: 16 * 1024 * 1024,
        channel_buffer_size: 1024,
        ..russh::client::Config::default()
    });
    let host_port = format_host_port(&session.host, session.port);
    let host_key_error = Arc::new(std::sync::Mutex::new(None));
    let handler = SshHandler {
        app: app.clone(),
        host_port: host_port.clone(),
        host_key_error: Arc::clone(&host_key_error),
    };

    let mut handle = tokio::time::timeout(
        SSH_CONNECT_TIMEOUT,
        russh::client::connect(config, (session.host.as_str(), session.port), handler),
    )
    .await
    .map_err(|_| format!("SSH 连接超时（{}s）：{}", SSH_CONNECT_TIMEOUT.as_secs(), session.host))?
    .map_err(|error| {
        if let Ok(guard) = host_key_error.lock() {
            if let Some(message) = guard.as_ref() {
                return message.clone();
            }
        }
        format!("SSH 连接失败：{error}")
    })?;

    emit_remote_log(app, terminal_id, "TCP connected, authenticating...");

    let auth_success = match &session.auth {
        AuthType::Password { secret_id }
        | AuthType::KeyboardInteractive {
            response_secret_id: secret_id,
        } => {
            handle
                .authenticate_password(session.username.as_str(), secret_id.as_str())
                .await
                .map_err(|error| format!("SSH 密码认证失败：{error}"))?
                .success()
        }
        AuthType::PrivateKey {
            key_id,
            passphrase_secret_id,
        } => {
            let passphrase = passphrase_secret_id.as_deref();
            let key = russh::keys::load_secret_key(key_id, passphrase)
                .map_err(|error| format!("SSH 私钥加载失败：{error}"))?;
            let key_with_alg = russh::keys::PrivateKeyWithHashAlg::new(
                Arc::new(key),
                None,
            );
            handle
                .authenticate_publickey(session.username.as_str(), key_with_alg)
                .await
                .map_err(|error| format!("SSH 私钥认证失败：{error}"))?
                .success()
        }
        AuthType::Agent | AuthType::Gssapi { .. } => {
            return Err(
                "当前内置 SSH 连接暂不支持该认证方式，请使用 Password 或 Private Key"
                    .to_string(),
            );
        }
    };

    if !auth_success {
        return Err("SSH 认证失败：服务端未接受当前凭据".to_string());
    }

    emit_remote_log(app, terminal_id, "Authentication successful");
    Ok(handle)
}

async fn interactive_remote_handle(
    state: &AppState,
    terminal_id: Uuid,
) -> Result<SharedRemoteHandle, String> {
    let terminals = state.remote_terminals.lock().await;
    terminals
        .get(&terminal_id)
        .map(|remote| Arc::clone(&remote.handle))
        .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))
}

async fn connect_russh_transfer_session(
    app: &AppHandle,
    terminal_id: Uuid,
    state: &AppState,
) -> Result<SharedRemoteHandle, String> {
    // Reuse a live transfer handle when possible (avoids re-auth per file).
    {
        let cache = state.transfer_handles.lock().await;
        if let Some(existing) = cache.get(&terminal_id) {
            return Ok(Arc::clone(existing));
        }
    }

    let stored_session_id = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|remote| remote.session_id)
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };
    let stored_session = {
        let sessions = state.sessions.lock().await;
        sessions
            .all()
            .iter()
            .find(|session| session.id == stored_session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {stored_session_id}"))?
    };
    let resolved = {
        let credentials = state.credentials.lock().await;
        resolved_session(&stored_session, &credentials)
    };
    let session = match resolved {
        Ok(session) => session,
        Err(error) => {
            emit_remote_log(
                app,
                &format!("{terminal_id}:transfer"),
                format!("Credential unavailable ({error}); using interactive connection"),
            );
            return interactive_remote_handle(state, terminal_id).await;
        }
    };
    let transfer_terminal_id = format!("{terminal_id}:transfer");
    match connect_russh_session(app, &transfer_terminal_id, &session).await {
        Ok(handle) => {
            drop(session);
            let shared = Arc::new(handle);
            match exec_remote_command_full(&shared, "true").await {
                Ok((_, _, Some(0))) => {
                    let mut cache = state.transfer_handles.lock().await;
                    cache.insert(terminal_id, Arc::clone(&shared));
                    Ok(shared)
                }
                Ok((_, stderr, code)) => {
                    let detail = String::from_utf8_lossy(&stderr);
                    emit_remote_log(
                        app,
                        &transfer_terminal_id,
                        format!("Dedicated transfer channel returned {code:?} ({detail}); using interactive connection"),
                    );
                    interactive_remote_handle(state, terminal_id).await
                }
                Err(error) => {
                    emit_remote_log(
                        app,
                        &transfer_terminal_id,
                        format!("Dedicated transfer channel unavailable ({error}); using interactive connection"),
                    );
                    interactive_remote_handle(state, terminal_id).await
                }
            }
        }
        Err(error) => {
            emit_remote_log(
                app,
                &transfer_terminal_id,
                format!("Dedicated transfer connection unavailable ({error}); using interactive connection"),
            );
            interactive_remote_handle(state, terminal_id).await
        }
    }
}

async fn invalidate_transfer_handle(state: &AppState, terminal_id: Uuid) {
    let mut cache = state.transfer_handles.lock().await;
    cache.remove(&terminal_id);
}

/// 清理任务认领终端表项：仅当表项仍属于 `closed_token` 标识的会话时才移除。
///
/// 同一 `terminal_id` 被新连接覆盖后，旧会话的清理任务可能晚于新会话插入
/// 才被关闭通知唤醒；此时不得误删新会话（否则新终端表现为假死）。
fn claim_terminal_cleanup<V>(
    terminals: &mut HashMap<Uuid, V>,
    terminal_id: Uuid,
    closed_token: &Arc<AtomicBool>,
    session_token: impl Fn(&V) -> &Arc<AtomicBool>,
) -> bool {
    let is_owner = terminals
        .get(&terminal_id)
        .is_some_and(|current| Arc::ptr_eq(session_token(current), closed_token));
    if is_owner {
        terminals.remove(&terminal_id);
    }
    is_owner
}

async fn spawn_russh_terminal(
    app: AppHandle,
    terminal_id: String,
    session_id: Uuid,
    handle: russh::client::Handle<SshHandler>,
) -> Result<RemoteTerminalSession, String> {
    emit_remote_log(&app, &terminal_id, "Opening channel...");

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;

    emit_remote_log(&app, &terminal_id, "Requesting PTY (xterm-256color 120x36)...");
    channel
        .request_pty(true, "xterm-256color", 120, 36, 0, 0, &[])
        .await
        .map_err(|error| format!("SSH PTY 创建失败：{error}"))?;

    emit_remote_log(&app, &terminal_id, "Requesting shell...");
    channel
        .request_shell(true)
        .await
        .map_err(|error| format!("SSH Shell 启动失败：{error}"))?;

    emit_remote_log(&app, &terminal_id, "Shell started, terminal ready");
    emit_remote_ready(&app, &terminal_id);

    let (tx, mut rx) = mpsc::channel::<RemoteTerminalCommand>(32);
    let closed = Arc::new(AtomicBool::new(false));
    let closed_clone = Arc::clone(&closed);
    let close_notification = Arc::new(Notify::new());
    let close_notification_clone = Arc::clone(&close_notification);
    let terminal_id_clone = terminal_id.clone();

    let shared_handle: SharedRemoteHandle = Arc::new(handle);
    let task_handle = Arc::clone(&shared_handle);

    // 拆分读/写半边：写入走独立任务。此前单一 select 循环中一次超大粘贴会因
    // SSH 流控在 channel.data() 上长期挂起，饿死 channel.wait() 的输出渲染、
    // 排队的 Resize，以及 Disconnect 发送的 Close。
    let (mut channel_read, channel_write) = channel.split();

    // 写入失败经此转发给读循环，由读循环统一发终端状态（保持原有对外语义）
    let write_failure_slot: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));
    let write_failure_signal = Arc::new(Notify::new());
    let failure_slot_clone = Arc::clone(&write_failure_slot);
    let failure_signal_clone = Arc::clone(&write_failure_signal);

    let writer_app = app.clone();
    let writer_terminal_id = terminal_id.clone();
    tokio::spawn(async move {
        const WRITE_CHUNK_BYTES: usize = 32 * 1024;
        let writer = channel_write;
        let mut pending_writes = std::collections::VecDeque::<Vec<u8>>::new();

        'writer: loop {
            // 等待第一条命令；有待发送数据时则在每个分块之间检查新命令。
            if pending_writes.is_empty() {
                match rx.recv().await {
                    Some(RemoteTerminalCommand::Write(data)) => {
                        for chunk in data.into_bytes().chunks(WRITE_CHUNK_BYTES) {
                            pending_writes.push_back(chunk.to_vec());
                        }
                    }
                    Some(RemoteTerminalCommand::Resize { cols, rows }) => {
                        let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(RemoteTerminalCommand::Close) | None => {
                        let _ = writer.eof().await;
                        let _ = writer.close().await;
                        break;
                    }
                }
                continue;
            }

            // 仅在远端窗口有空间时发送，并把单次发送限制在 32KB 内。
            // 窗口耗尽时先轮询控制命令，避免 Resize/Close 被卡在一个无限等待的
            // 大数据写入上；已发送的前缀不会被取消或重复。
            let writable = writer.writable_packet_size().await;
            if writable == 0 {
                match rx.try_recv() {
                    Ok(RemoteTerminalCommand::Write(data)) => {
                        for chunk in data.into_bytes().chunks(WRITE_CHUNK_BYTES) {
                            pending_writes.push_back(chunk.to_vec());
                        }
                    }
                    Ok(RemoteTerminalCommand::Resize { cols, rows }) => {
                        let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Ok(RemoteTerminalCommand::Close)
                    | Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                        let _ = writer.eof().await;
                        let _ = writer.close().await;
                        break 'writer;
                    }
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
                continue;
            }

            let Some(mut chunk) = pending_writes.pop_front() else {
                continue;
            };
            let send_limit = writable.min(WRITE_CHUNK_BYTES);
            if chunk.len() > send_limit {
                let remainder = chunk.split_off(send_limit);
                pending_writes.push_front(remainder);
            }
            if let Err(error) = writer.data(chunk.as_slice()).await {
                let message = format!("终端写入失败：{error}");
                emit_remote_log(&writer_app, &writer_terminal_id, &message);
                if let Ok(mut slot) = failure_slot_clone.lock() {
                    *slot = Some(message);
                }
                failure_signal_clone.notify_one();
                let _ = writer.eof().await;
                let _ = writer.close().await;
                break;
            }

            // 一个分块完成后优先处理已经排队的控制命令。这样 Resize/Close
            // 最多等待当前 32KB 分块，不会在大粘贴后排队数百 KB。
            loop {
                match rx.try_recv() {
                    Ok(RemoteTerminalCommand::Write(data)) => {
                        for chunk in data.into_bytes().chunks(WRITE_CHUNK_BYTES) {
                            pending_writes.push_back(chunk.to_vec());
                        }
                    }
                    Ok(RemoteTerminalCommand::Resize { cols, rows }) => {
                        let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Ok(RemoteTerminalCommand::Close) | Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                        let _ = writer.eof().await;
                        let _ = writer.close().await;
                        break 'writer;
                    }
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                }
            }
        }
    });

    tokio::spawn(async move {
        let mut close_state = TerminalLifecycleState::Disconnected;
        let mut close_reason = None;
        let mut output_decoder = StreamDecoder::new();
        loop {
            tokio::select! {
                msg = channel_read.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            emit_terminal_output(
                                &app,
                                terminal_id_clone.clone(),
                                output_decoder.feed(data),
                            );
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            emit_terminal_output(
                                &app,
                                terminal_id_clone.clone(),
                                output_decoder.feed(data),
                            );
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
                _ = write_failure_signal.notified() => {
                    close_state = TerminalLifecycleState::Failed;
                    close_reason = write_failure_slot.lock().ok().and_then(|mut slot| slot.take());
                    break;
                }
            }
        }

        output_decoder.flush();
        closed_clone.store(true, Ordering::SeqCst);
        close_notification_clone.notify_one();
        // eof/close 由写入任务统一负责（Close/None/失败路径均已处理）
        emit_terminal_status(
            &app,
            terminal_id_clone,
            TerminalTransport::Remote,
            close_state,
            close_reason,
        );
        drop(task_handle);
    });

    Ok(RemoteTerminalSession {
        control: tx,
        closed,
        close_notification,
        handle: shared_handle,
        session_id,
    })
}

/// Quote a path for safe interpolation into a POSIX shell command (single-quote wrap).
pub(crate) fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

/// Run a one-shot command on a fresh exec channel over an existing SSH handle and
/// collect stdout. Used by remote directory listing / file preview.
async fn exec_remote_command(
    handle: &russh::client::Handle<SshHandler>,
    command: &str,
) -> Result<Vec<u8>, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let mut output: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => output.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok(output)
}

/// Like exec_remote_command but also collects stderr and exit status.
/// Returns (stdout, stderr, exit_code). Fails only on channel errors.
async fn exec_remote_command_full(
    handle: &russh::client::Handle<SshHandler>,
    command: &str,
) -> Result<(Vec<u8>, Vec<u8>, Option<i32>), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<i32> = None;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => stdout.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => stderr.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status as i32);
            }
            // Don't break on Eof — ExitStatus may arrive after it.
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok((stdout, stderr, exit_code))
}

async fn exec_remote_command_full_cancellable(
    handle: &russh::client::Handle<SshHandler>,
    command: &str,
    cancellation: &AtomicBool,
) -> Result<(Vec<u8>, Vec<u8>, Option<i32>), String> {
    if cancellation.load(Ordering::SeqCst) {
        return Err("传输已取消".to_string());
    }
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    loop {
        let message = tokio::select! {
            message = channel.wait() => message,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancellation.load(Ordering::SeqCst) {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    return Err("传输已取消".to_string());
                }
                continue;
            }
        };
        match message {
            Some(ChannelMsg::Data { ref data }) => stdout.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => stderr.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status as i32),
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    Ok((stdout, stderr, exit_code))
}

fn emit_file_open_progress(app: &AppHandle, transfer_id: &str, transferred: usize, total: u64) {
    let _ = app.emit(
        "file-open-progress",
        serde_json::json!({
            "transfer_id": transfer_id,
            "transferred": transferred,
            "total": total,
        }),
    );
}

async fn exec_remote_command_full_with_progress(
    handle: &russh::client::Handle<SshHandler>,
    command: &str,
    app: &AppHandle,
    transfer_id: &str,
    total: u64,
    cancellation: &AtomicBool,
) -> Result<(Vec<u8>, Vec<u8>, Option<i32>), String> {
    if cancellation.load(Ordering::SeqCst) {
        return Err("传输已取消".to_string());
    }
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut last_progress_emit = Instant::now();
    emit_file_open_progress(app, transfer_id, 0, total);

    loop {
        if cancellation.load(Ordering::SeqCst) {
            let _ = channel.eof().await;
            let _ = channel.close().await;
            return Err("传输已取消".to_string());
        }
        let message = tokio::select! {
            message = channel.wait() => message,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                continue;
            }
        };
        match message {
            Some(ChannelMsg::Data { ref data }) => {
                stdout.extend_from_slice(data);
                if last_progress_emit.elapsed() >= Duration::from_millis(80)
                    || (total > 0 && stdout.len() as u64 >= total)
                {
                    emit_file_open_progress(app, transfer_id, stdout.len(), total);
                    last_progress_emit = Instant::now();
                }
            }
            Some(ChannelMsg::ExtendedData { ref data, .. }) => stderr.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status as i32),
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    emit_file_open_progress(app, transfer_id, stdout.len(), total);
    Ok((stdout, stderr, exit_code))
}

fn local_terminal_exit_state(failure: Option<&str>) -> TerminalLifecycleState {
    if failure.is_some() {
        TerminalLifecycleState::Failed
    } else {
        TerminalLifecycleState::Disconnected
    }
}

fn take_terminal_session<T>(
    terminals: &mut HashMap<Uuid, T>,
    terminal_id: Uuid,
) -> Option<T> {
    terminals.remove(&terminal_id)
}

fn emit_terminal_status(
    app: &AppHandle,
    terminal_id: impl Into<String>,
    transport: TerminalTransport,
    state: TerminalLifecycleState,
    reason: Option<String>,
) {
    let event = TerminalStatusEvent {
        terminal_id: terminal_id.into(),
        transport,
        state,
        reason,
    };
    if let Err(error) = app.emit(TERMINAL_STATUS_EVENT, event) {
        eprintln!("[Terminal] emit FAILED for terminal-status: {error}");
    }
}

fn emit_terminal_output(app: &AppHandle, terminal_id: String, payload: String) {
    if payload.is_empty() {
        return;
    }

    let event = TerminalOutputEvent {
        terminal_id,
        payload,
    };
    let result = app.emit(TERMINAL_OUTPUT_EVENT, event);
    if let Err(ref e) = result {
        eprintln!("[PTY] emit FAILED for terminal_output: {}", e);
    }
}

fn spawn_terminal_reader(
    app: AppHandle,
    terminal_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    writer: SharedWriter,
    state: Arc<AppState>,
) {
    let terminal_id_text = terminal_id.to_string();
    eprintln!("[PTY] spawn_terminal_reader started for terminal_id={}", terminal_id_text);
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut output_decoder = StreamDecoder::new();
        let mut failure = None;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    eprintln!("[PTY] reader returned 0 (EOF) for terminal_id={}", terminal_id_text);
                    break;
                }
                Ok(size) => {
                    let decoded = output_decoder.feed(&buffer[..size]);

                    let visible_output = if decoded.contains("\u{1b}[6n") {
                        if let Ok(mut guard) = writer.lock() {
                            let _ = guard.write_all(b"\x1b[1;1R");
                            let _ = guard.flush();
                        }
                        decoded.replace("\u{1b}[6n", "")
                    } else {
                        decoded
                    };

                    if !visible_output.is_empty() {
                        emit_terminal_output(&app, terminal_id_text.clone(), visible_output);
                    }
                }
                Err(error) => {
                    let message = format!("终端读取失败：{error}");
                    eprintln!("[PTY] reader error for terminal_id={}: {}", terminal_id_text, error);
                    failure = Some(message);
                    break;
                }
            }
        }

        output_decoder.flush();
        tauri::async_runtime::spawn(async move {
            let session = {
                let mut terminals = state.local_terminals.lock().await;
                take_terminal_session(&mut terminals, terminal_id)
            };
            if let Some(mut session) = session {
                let lifecycle_state = local_terminal_exit_state(failure.as_deref());
                emit_terminal_status(
                    &app,
                    terminal_id_text,
                    TerminalTransport::Local,
                    lifecycle_state,
                    failure.clone(),
                );
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if failure.is_some() {
                        let _ = session.child.kill();
                    }
                    let _ = session.child.wait();
                })
                .await;
            }
        });
    });
}


fn default_download_directory() -> Result<PathBuf, String> {
    let downloads = default_local_path()?.join("Downloads");
    fs::create_dir_all(&downloads).map_err(|error| format!("创建下载目录失败：{error}"))?;
    Ok(downloads)
}

fn local_destination_candidate(
    directory: &Path,
    file_name: &str,
    index: usize,
) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    let Some(std::path::Component::Normal(normal_name)) = components.next() else {
        return Err("无法确定下载文件名".to_string());
    };
    if components.next().is_some() || file_name.contains(['/', '\\']) {
        return Err("下载文件名包含非法路径分隔符".to_string());
    }
    if index == 0 {
        return Ok(directory.join(normal_name));
    }

    let path = Path::new(normal_name);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    Ok(directory.join(format!("{stem} ({index}){extension}")))
}

fn write_unique_local_file(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    local_destination_candidate(directory, file_name, 0)?;
    let temporary = directory.join(format!(".pandaterm-download-{}.tmp", Uuid::new_v4()));
    let prepare_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("创建下载临时文件失败：{error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("写入下载临时文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步下载临时文件失败：{error}"))
    })();
    if let Err(error) = prepare_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    for index in 0..=10_000 {
        let candidate = local_destination_candidate(directory, file_name, index)?;
        match fs::hard_link(&temporary, &candidate) {
            Ok(()) => {
                let _ = fs::remove_file(&temporary);
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!("提交下载文件失败：{error}"));
            }
        }
    }
    let _ = fs::remove_file(&temporary);
    Err("下载目录中同名文件过多".to_string())
}



const REMOTE_FILE_PREVIEW_LIMIT: usize = 64 * 1024;

#[tauri::command]
async fn list_remote_directory(
    terminal_id: Uuid,
    path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<LocalDirectoryListing, String> {
    let handle = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };

    let target = path
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    let quoted = shell_quote(target);
    // Probe GNU find -printf; fall back to portable shell loop (BusyBox/BSD).
    let command = format!(
        "__p=$(cd {quoted} 2>/dev/null && pwd) || __p={quoted}; \
         printf 'P:%s\\n' \"$__p\"; \
         __d=$(dirname \"$__p\"); [ \"$__d\" = \"$__p\" ] && __d=''; \
         printf 'D:%s\\n' \"$__d\"; \
         if find \"$__p\" -mindepth 1 -maxdepth 1 -printf '' >/dev/null 2>&1; then \
           find \"$__p\" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null; \
         else \
           for f in \"$__p\"/* \"$__p\"/.[!.]* \"$__p\"/..?*; do \
             [ -e \"$f\" ] || continue; \
             name=$(basename \"$f\"); \
             if [ -d \"$f\" ]; then t=d; else t=f; fi; \
             sz=$(stat -c %s \"$f\" 2>/dev/null || stat -f %z \"$f\" 2>/dev/null || echo 0); \
             mt=$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\" 2>/dev/null || echo 0); \
             printf '%s\\t%s\\t%s\\t%s\\n' \"$t\" \"$sz\" \"$mt\" \"$name\"; \
           done; \
         fi"
    );
    let output = exec_remote_command(&handle, &command).await?;
    let text = String::from_utf8_lossy(&output);
    parse_remote_listing(&text)
}

#[tauri::command]
async fn read_remote_file_preview(
    terminal_id: Uuid,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<LocalFilePreview, String> {
    let handle = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };

    let quoted = shell_quote(&path);
    let command = format!(
        "__size=$(stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null) || exit $?; \
         printf 'SIZE:%s\\n' \"$__size\"; \
         head -c {limit} {quoted} 2>/dev/null || dd if={quoted} bs={limit} count=1 2>/dev/null",
        limit = REMOTE_FILE_PREVIEW_LIMIT
    );
    let (output, stderr, exit_code) = exec_remote_command_full(&handle, &command).await?;
    if exit_code != Some(0) {
        return Err(format!(
            "远程文件读取失败（退出码 {exit_code:?}）：{}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }

    let newline_pos = output
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(|| "远程文件响应格式异常".to_string())?;
    let size_line = String::from_utf8_lossy(&output[..newline_pos]);
    let size: u64 = size_line
        .strip_prefix("SIZE:")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let content_bytes = &output[(newline_pos + 1).min(output.len())..];
    let content = String::from_utf8_lossy(content_bytes).into_owned();
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();

    Ok(LocalFilePreview {
        path,
        name,
        size,
        content,
        truncated: (size as usize) > content_bytes.len(),
    })
}

#[tauri::command]
async fn read_remote_file_full(
    terminal_id: Uuid,
    path: String,
    transfer_id: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<LocalFilePreview, String> {
    let cancellation = if let Some(id) = transfer_id.as_deref() {
        Some(register_transfer_cancellation(&state, id).await)
    } else {
        None
    };

    let result = async {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&terminal_id)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
        };

        let quoted = shell_quote(&path);
        // Check size first to avoid pulling huge files through the SSH channel.
        let (size_output, size_stderr, size_code) = exec_remote_command_full(
            &handle,
            &format!(
                "stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null"
            ),
        )
        .await?;
        if size_code != Some(0) {
            return Err(format!(
                "远程文件大小读取失败（退出码 {size_code:?}）：{}",
                String::from_utf8_lossy(&size_stderr).trim()
            ));
        }
        let size_str = String::from_utf8_lossy(&size_output);
        let size: u64 = size_str
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if size > REMOTE_FILE_FULL_LIMIT {
            return Err(format!(
                "文件过大（{} 字节），编辑器最多支持 {} 字节的文件",
                size, REMOTE_FILE_FULL_LIMIT
            ));
        }

        let command = format!("cat {quoted}");
        let (output, stderr, exit_code) = match (transfer_id.as_deref(), cancellation.as_deref()) {
            (Some(id), Some(signal)) => {
                exec_remote_command_full_with_progress(&handle, &command, &app, id, size, signal).await?
            }
            _ => exec_remote_command_full(&handle, &command).await?,
        };
        if exit_code != Some(0) {
            return Err(format!(
                "远程文件读取失败（退出码 {exit_code:?}）：{}",
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        let content = String::from_utf8(output)
            .map_err(|_| "暂不支持编辑二进制文件".to_string())?;
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();

        Ok(LocalFilePreview {
            path,
            name,
            size,
            content,
            truncated: false,
        })
    }
    .await;

    if let (Some(id), Some(signal)) = (transfer_id.as_deref(), cancellation.as_ref()) {
        finish_transfer_cancellation(&state, id, signal).await;
    }
    result
}

const REMOTE_UPLOAD_COMPLETION_MARKER: &[u8] = b"__PANDATERM_UPLOAD_COMPLETE__";

/// 读取远程 exec 输出时保留的尾部字节上限。
/// 远端若在 marker 之前输出了 banner / motd / 警告，旧的"只取前 128 字节"会把
/// 最后才输出的完成标记截断，导致明明写成功却误判为"未收到完成标记" → 保存失败。
/// 完成标记是最后输出的，保留尾部即可稳定命中，同时限制内存占用。
const REMOTE_OUTPUT_TAIL_LIMIT: usize = 4096;

fn format_remote_stderr(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        // Keep the UI message compact; remote shells may dump multi-line noise.
        let single_line = trimmed
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        const MAX_LEN: usize = 240;
        if single_line.chars().count() > MAX_LEN {
            let short: String = single_line.chars().take(MAX_LEN).collect();
            Some(format!("{short}…"))
        } else {
            Some(single_line)
        }
    }
}

fn validate_remote_upload_completion(
    exit_code: Option<i32>,
    completion_marker_seen: bool,
    stderr: &[u8],
) -> Result<(), String> {
    let detail = format_remote_stderr(stderr);
    match (exit_code, completion_marker_seen) {
        (Some(0) | None, true) => Ok(()),
        (Some(0), false) => Err(match detail {
            Some(msg) => format!("远程写入失败：未收到完成标记（{msg}）"),
            None => "远程写入失败：未收到完成标记".to_string(),
        }),
        (Some(code), _) => Err(match detail {
            // e.g. Permission denied / No such file or directory / Disk quota exceeded
            Some(msg) => format!("远程写入失败，退出码: {code}（{msg}）"),
            None => format!("远程写入失败，退出码: {code}"),
        }),
        (None, false) => Err(match detail {
            Some(msg) => format!("远程写入失败：SSH 通道未返回退出状态或完成标记（{msg}）"),
            None => "远程写入失败：SSH 通道未返回退出状态或完成标记".to_string(),
        }),
    }
}

fn emit_upload_progress(
    app: &AppHandle,
    transfer_id: &str,
    transferred: usize,
    total: usize,
) {
    let _ = app.emit(
        "upload-progress",
        serde_json::json!({
            "transfer_id": transfer_id,
            "phase": "transferring",
            "transferred": transferred,
            "total": total,
        }),
    );
}

fn emit_upload_phase(app: &AppHandle, transfer_id: &str, phase: &str) {
    let _ = app.emit(
        "upload-progress",
        serde_json::json!({
            "transfer_id": transfer_id,
            "phase": phase,
        }),
    );
}

/// Write full file content to a remote path by piping data through one
/// `cat > path` exec channel. Concurrently drains server→client output so
/// OpenSSH window updates keep flowing (avoids the classic ~2MB hang).
async fn write_remote_file_content(
    handle: &russh::client::Handle<SshHandler>,
    path: &str,
    content: &[u8],
    app: &AppHandle,
    transfer_id: &str,
    cancellation: Option<&AtomicBool>,
    attempt_started: &AtomicBool,
) -> Result<(), String> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err("上传已取消".to_string());
    }
    let total = content.len();
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    let quoted = shell_quote(path);
    channel
        .exec(
            true,
            format!(
                "if cat > {quoted}; then printf '%s\\n' __PANDATERM_UPLOAD_COMPLETE__; else exit $?; fi"
            ),
        )
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let (mut reader, writer) = channel.split();
    let read_task = tokio::spawn(async move {
        let mut exit_code = None;
        let mut completion_output = Vec::new();
        let mut stderr_output = Vec::new();
        while let Some(msg) = reader.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    // 保留尾部输出：完成标记是最后打印的，若被远端前置输出挤掉会误判为失败
                    completion_output.extend_from_slice(&data[..]);
                    let len = completion_output.len();
                    if len > REMOTE_OUTPUT_TAIL_LIMIT {
                        completion_output.drain(..len - REMOTE_OUTPUT_TAIL_LIMIT);
                    }
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    stderr_output.extend_from_slice(&data[..]);
                    let len = stderr_output.len();
                    if len > REMOTE_OUTPUT_TAIL_LIMIT {
                        stderr_output.drain(..len - REMOTE_OUTPUT_TAIL_LIMIT);
                    }
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status as i32);
                }
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        let completion_marker_seen = completion_output
            .windows(REMOTE_UPLOAD_COMPLETION_MARKER.len())
            .any(|window| window == REMOTE_UPLOAD_COMPLETION_MARKER);
        (exit_code, completion_marker_seen, stderr_output)
    });

    let mut transferred = 0usize;
    let mut last_progress_emit = Instant::now();
    for part in content.chunks(32 * 1024) {
        if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            let _ = writer.close().await;
            read_task.abort();
            return Err("上传已取消".to_string());
        }
        writer
            .data(part)
            .await
            .map_err(|error| format!("SSH 数据写入失败：{error}"))?;
        attempt_started.store(true, Ordering::SeqCst);
        transferred += part.len();
        if last_progress_emit.elapsed() >= Duration::from_secs(1) {
            emit_upload_progress(app, transfer_id, transferred, total);
            last_progress_emit = Instant::now();
        }
    }

    emit_upload_phase(app, transfer_id, "verifying");
    writer
        .eof()
        .await
        .map_err(|error| format!("SSH eof 失败：{error}"))?;
    let (observed_exit_code, completion_marker_seen, stderr_output) = read_task
        .await
        .map_err(|error| format!("等待远程写入确认失败：{error}"))?;
    let _ = writer.close().await;
    validate_remote_upload_completion(observed_exit_code, completion_marker_seen, &stderr_output)
}

/// Stream a local file to remote via one SSH channel + concurrent output drain.
async fn stream_upload_file(
    handle: &russh::client::Handle<SshHandler>,
    local_path: &Path,
    remote_path: &str,
    transfer_id: &str,
    app: &AppHandle,
    cancellation: Option<&AtomicBool>,
    attempt_started: &AtomicBool,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err("上传已取消".to_string());
    }
    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("打开本地文件失败：{e}"))?;
    let total = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("读取文件信息失败：{e}"))?
        .len() as usize;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    let quoted = shell_quote(remote_path);
    channel
        .exec(
            true,
            format!(
                "if cat > {quoted}; then printf '%s\\n' __PANDATERM_UPLOAD_COMPLETE__; else exit $?; fi"
            ),
        )
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    let (mut reader, writer) = channel.split();
    let read_task = tokio::spawn(async move {
        let mut exit_code = None;
        let mut completion_output = Vec::new();
        let mut stderr_output = Vec::new();
        while let Some(msg) = reader.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    // 保留尾部输出：完成标记是最后打印的，若被远端前置输出挤掉会误判为失败
                    completion_output.extend_from_slice(&data[..]);
                    let len = completion_output.len();
                    if len > REMOTE_OUTPUT_TAIL_LIMIT {
                        completion_output.drain(..len - REMOTE_OUTPUT_TAIL_LIMIT);
                    }
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    stderr_output.extend_from_slice(&data[..]);
                    let len = stderr_output.len();
                    if len > REMOTE_OUTPUT_TAIL_LIMIT {
                        stderr_output.drain(..len - REMOTE_OUTPUT_TAIL_LIMIT);
                    }
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status as i32);
                }
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        let completion_marker_seen = completion_output
            .windows(REMOTE_UPLOAD_COMPLETION_MARKER.len())
            .any(|window| window == REMOTE_UPLOAD_COMPLETION_MARKER);
        (exit_code, completion_marker_seen, stderr_output)
    });

    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred = 0usize;
    let mut last_progress_emit = Instant::now();
    loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            let _ = writer.close().await;
            read_task.abort();
            return Err("上传已取消".to_string());
        }
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取本地文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        writer
            .data(&buffer[..n])
            .await
            .map_err(|error| format!("SSH 数据写入失败：{error}"))?;
        attempt_started.store(true, Ordering::SeqCst);
        transferred += n;
        if last_progress_emit.elapsed() >= Duration::from_secs(1) {
            emit_upload_progress(app, transfer_id, transferred, total);
            last_progress_emit = Instant::now();
        }
    }

    emit_upload_phase(app, transfer_id, "verifying");
    writer
        .eof()
        .await
        .map_err(|error| format!("SSH eof 失败：{error}"))?;
    let (observed_exit_code, completion_marker_seen, stderr_output) = read_task
        .await
        .map_err(|error| format!("等待远程写入确认失败：{error}"))?;
    let _ = writer.close().await;
    validate_remote_upload_completion(observed_exit_code, completion_marker_seen, &stderr_output)
}

async fn remove_remote_temp_file(
    handle: &russh::client::Handle<SshHandler>,
    temp_path: &str,
) {
    let _ = exec_remote_command_full(handle, &format!("rm -f {}", shell_quote(temp_path))).await;
}

async fn commit_remote_temp_file(
    handle: &russh::client::Handle<SshHandler>,
    temp_path: &str,
    destination_path: &str,
) -> Result<(), String> {
    let command = format!(
        "mv -f {} {}",
        shell_quote(temp_path),
        shell_quote(destination_path)
    );
    let (_, stderr, code) = exec_remote_command_full(handle, &command).await?;
    if code != Some(0) {
        return Err(format!(
            "远程文件提交失败: {}",
            String::from_utf8_lossy(&stderr)
        ));
    }
    Ok(())
}

fn remote_temp_path(destination_path: &str, transfer_id: &str) -> String {
    let suffix: String = transfer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .collect();
    format!("{destination_path}.pandaterm-{}.part", if suffix.is_empty() { "transfer" } else { &suffix })
}

async fn write_remote_file_atomic(
    handle: &russh::client::Handle<SshHandler>,
    destination_path: &str,
    content: &[u8],
    app: &AppHandle,
    transfer_id: &str,
    cancellation: Option<&AtomicBool>,
    attempt_started: &AtomicBool,
) -> Result<(), String> {
    let temp_path = remote_temp_path(destination_path, transfer_id);
    if let Err(error) = write_remote_file_content(
        handle,
        &temp_path,
        content,
        app,
        transfer_id,
        cancellation,
        attempt_started,
    )
    .await
    {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err(error);
    }
    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err("上传已取消".to_string());
    }
    emit_upload_phase(app, transfer_id, "committing");
    if let Err(error) = commit_remote_temp_file(handle, &temp_path, destination_path).await {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err(error);
    }
    Ok(())
}

async fn stream_upload_file_atomic(
    handle: &russh::client::Handle<SshHandler>,
    local_path: &Path,
    destination_path: &str,
    transfer_id: &str,
    app: &AppHandle,
    cancellation: Option<&AtomicBool>,
    attempt_started: &AtomicBool,
) -> Result<(), String> {
    let temp_path = remote_temp_path(destination_path, transfer_id);
    if let Err(error) = stream_upload_file(
        handle,
        local_path,
        &temp_path,
        transfer_id,
        app,
        cancellation,
        attempt_started,
    )
    .await
    {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err(error);
    }
    if cancellation.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err("上传已取消".to_string());
    }
    emit_upload_phase(app, transfer_id, "committing");
    if let Err(error) = commit_remote_temp_file(handle, &temp_path, destination_path).await {
        remove_remote_temp_file(handle, &temp_path).await;
        return Err(error);
    }
    Ok(())
}

fn bounded_ai_terminal_output(stdout: &[u8], stderr: &[u8]) -> (String, bool) {
    let mut combined = Vec::with_capacity(stdout.len() + stderr.len() + 16);
    combined.extend_from_slice(stdout);
    if !stdout.is_empty() && !stderr.is_empty() && !stdout.ends_with(b"\n") {
        combined.push(b'\n');
    }
    combined.extend_from_slice(stderr);
    if combined.len() <= AI_TERMINAL_OUTPUT_LIMIT {
        return (String::from_utf8_lossy(&combined).into_owned(), false);
    }
    let start = combined.len() - AI_TERMINAL_OUTPUT_LIMIT;
    (
        format!(
            "[输出已截断，仅保留最后 {} 字节]\n{}",
            AI_TERMINAL_OUTPUT_LIMIT,
            String::from_utf8_lossy(&combined[start..])
        ),
        true,
    )
}

async fn run_ai_local_terminal_command(
    command: &str,
    timeout_duration: Duration,
) -> Result<AiTerminalCommandResult, String> {
    let mut process = if cfg!(target_os = "windows") {
        let mut process = Command::new("powershell.exe");
        process
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(command);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.arg("-lc").arg(command);
        process
    };
    process
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match tokio::time::timeout(timeout_duration, process.output()).await {
        Ok(result) => result.map_err(|error| format!("启动本地命令失败：{error}"))?,
        Err(_) => {
            return Ok(AiTerminalCommandResult {
                output: "命令执行超时，进程已终止".to_string(),
                exit_code: None,
                truncated: false,
                timed_out: true,
            });
        }
    };
    let (output_text, truncated) = bounded_ai_terminal_output(&output.stdout, &output.stderr);
    Ok(AiTerminalCommandResult {
        output: output_text,
        exit_code: output.status.code(),
        truncated,
        timed_out: false,
    })
}

#[tauri::command]
async fn run_ai_terminal_command(
    request: AiTerminalCommandRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiTerminalCommandResult, String> {
    let command = request.command.trim();
    if command.is_empty() || command.len() > AI_TERMINAL_COMMAND_MAX_LENGTH {
        return Err(format!(
            "命令长度必须为 1-{} 字节",
            AI_TERMINAL_COMMAND_MAX_LENGTH
        ));
    }
    if !(AI_TERMINAL_MIN_TIMEOUT_MS..=AI_TERMINAL_MAX_TIMEOUT_MS)
        .contains(&request.timeout_ms)
    {
        return Err(format!(
            "命令超时必须为 {}-{} 毫秒",
            AI_TERMINAL_MIN_TIMEOUT_MS, AI_TERMINAL_MAX_TIMEOUT_MS
        ));
    }
    let terminal_id = Uuid::parse_str(&request.terminal_id)
        .map_err(|error| format!("终端标识无效：{error}"))?;
    let timeout_duration = Duration::from_millis(request.timeout_ms);

    if !request.is_remote {
        let terminals = state.local_terminals.lock().await;
        if !terminals.contains_key(&terminal_id) {
            return Err("本地终端已经关闭".to_string());
        }
        drop(terminals);
        return run_ai_local_terminal_command(command, timeout_duration).await;
    }

    let handle = interactive_remote_handle(&state, terminal_id).await?;
    let (stdout, stderr, exit_code) = match tokio::time::timeout(
        timeout_duration,
        exec_remote_command_full(&handle, command),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Ok(AiTerminalCommandResult {
                output: "命令执行超时，SSH exec 通道已关闭".to_string(),
                exit_code: None,
                truncated: false,
                timed_out: true,
            });
        }
    };
    let (output, truncated) = bounded_ai_terminal_output(&stdout, &stderr);
    Ok(AiTerminalCommandResult {
        output,
        exit_code,
        truncated,
        timed_out: false,
    })
}

#[tauri::command]
async fn write_local_file_checked(
    path: String,
    expected_content: String,
    content: String,
) -> Result<(), String> {
    if content.len() as u64 > LOCAL_FILE_FULL_LIMIT {
        return Err(format!(
            "修改后的文件过大（{} 字节），最多允许 {} 字节",
            content.len(),
            LOCAL_FILE_FULL_LIMIT
        ));
    }
    let canonical_file = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("本地文件校验失败：{error}"))?;
    let metadata = fs::metadata(&canonical_file)
        .map_err(|error| format!("本地文件校验失败：{error}"))?;
    if !metadata.is_file() {
        return Err("只能修改文件".to_string());
    }
    if metadata.len() > LOCAL_FILE_FULL_LIMIT {
        return Err(format!(
            "原文件过大（{} 字节），最多允许 {} 字节",
            metadata.len(),
            LOCAL_FILE_FULL_LIMIT
        ));
    }
    let current = fs::read_to_string(&canonical_file)
        .map_err(|error| format!("本地文件校验失败：{error}"))?;
    if current != expected_content {
        return Err("AI_EDIT_STALE:文件内容已变化，请重新读取并生成修改提案".to_string());
    }
    atomic_write_bytes(&canonical_file, content.as_bytes())
        .map_err(|error| format!("本地文件保存失败：{error}"))
}

#[tauri::command]
async fn write_local_file(path: String, content: String) -> Result<(), String> {
    atomic_write_bytes(Path::new(&path), content.as_bytes())
        .map_err(|error| format!("本地文件保存失败：{error}"))
}

#[tauri::command]
async fn write_remote_file_checked(
    terminal_id: Uuid,
    path: String,
    expected_content: String,
    content: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if expected_content.len() as u64 > REMOTE_FILE_FULL_LIMIT
        || content.len() as u64 > REMOTE_FILE_FULL_LIMIT
    {
        return Err(format!(
            "AI 修改文件最多允许 {} 字节",
            REMOTE_FILE_FULL_LIMIT
        ));
    }

    let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
    let quoted = shell_quote(&path);
    let (current, stderr, exit_code) =
        exec_remote_command_full(&handle, &format!("cat {quoted}")).await?;
    if exit_code != Some(0) {
        return Err(format!(
            "远程文件校验失败（退出码 {exit_code:?}）：{}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    if current != expected_content.as_bytes() {
        return Err("AI_EDIT_STALE:文件内容已变化，请重新读取并生成修改提案".to_string());
    }

    let transfer_id = Uuid::new_v4().to_string();
    let attempt_started = AtomicBool::new(false);
    write_remote_file_atomic(
        &handle,
        &path,
        content.as_bytes(),
        &app,
        &transfer_id,
        None,
        &attempt_started,
    )
    .await
}

#[tauri::command]
async fn write_remote_file(
    terminal_id: Uuid,
    path: String,
    content: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Use the dedicated transfer connection so editor saves do not starve the shell.
    let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
    let transfer_id = Uuid::new_v4().to_string();
    let attempt_started = AtomicBool::new(false);
    match write_remote_file_atomic(&handle, &path, content.as_bytes(), &app, &transfer_id, None, &attempt_started).await {
        Ok(()) => Ok(()),
        Err(error) if !attempt_started.load(Ordering::SeqCst) => {
            invalidate_transfer_handle(&state, terminal_id).await;
            let handle = interactive_remote_handle(&state, terminal_id).await?;
            write_remote_file_atomic(&handle, &path, content.as_bytes(), &app, &transfer_id, None, &attempt_started).await
                .map_err(|retry_err| format!("{error}; 重试失败: {retry_err}"))
        }
        Err(error) => Err(error),
    }
}

async fn register_transfer_cancellation(state: &AppState, transfer_id: &str) -> Arc<AtomicBool> {
    let mut cancellations = state.transfer_cancellations.lock().await;
    let entry = cancellations
        .entry(transfer_id.to_string())
        .or_insert_with(|| TransferCancellationEntry {
            signal: Arc::new(AtomicBool::new(false)),
            registered: false,
        });
    entry.registered = true;
    Arc::clone(&entry.signal)
}

async fn finish_transfer_cancellation(
    state: &AppState,
    transfer_id: &str,
    cancellation: &Arc<AtomicBool>,
) {
    let mut cancellations = state.transfer_cancellations.lock().await;
    if cancellations
        .get(transfer_id)
        .is_some_and(|current| Arc::ptr_eq(&current.signal, cancellation))
    {
        cancellations.remove(transfer_id);
    }
}

async fn discard_unregistered_cancellation(
    state: &AppState,
    transfer_id: &str,
    cancellation: &Arc<AtomicBool>,
) {
    let mut cancellations = state.transfer_cancellations.lock().await;
    if cancellations.get(transfer_id).is_some_and(|current| {
        !current.registered && Arc::ptr_eq(&current.signal, cancellation)
    }) {
        cancellations.remove(transfer_id);
    }
}

#[tauri::command]
async fn cancel_transfer(
    transfer_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let cancellation = {
        let mut cancellations = state.transfer_cancellations.lock().await;
        let entry = cancellations
            .entry(transfer_id.clone())
            .or_insert_with(|| TransferCancellationEntry {
                signal: Arc::new(AtomicBool::new(true)),
                registered: false,
            });
        Arc::clone(&entry.signal)
    };
    cancellation.store(true, Ordering::SeqCst);

    let cleanup_state = Arc::clone(state.inner());
    tokio::spawn(async move {
        // cancel 后 30s 仍未注册的传输视为已放弃；缩短兜底窗口，
        // 避免多次取消在后台滞留大量 5 分钟才结束的空转清理任务
        tokio::time::sleep(Duration::from_secs(30)).await;
        discard_unregistered_cancellation(&cleanup_state, &transfer_id, &cancellation).await;
    });
    Ok(())
}

#[tauri::command]
async fn upload_file(
    terminal_id: Option<Uuid>,
    file_name: String,
    content_base64: String,
    dest_dir: String,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let cancellation = register_transfer_cancellation(&state, &transfer_id).await;
    let result = async {
        if cancellation.load(Ordering::SeqCst) {
            return Err("上传已取消".to_string());
        }
        if file_name.contains('/') || file_name.contains('\\') || file_name == "." || file_name == ".." {
            return Err("文件名不能包含路径分隔符或相对路径组件".to_string());
        }
        let content = base64_decode(&content_base64)
            .map_err(|e| format!("Base64 解码失败：{e}"))?;
        let dest_path = if dest_dir.ends_with('/') {
            format!("{dest_dir}{file_name}")
        } else {
            format!("{dest_dir}/{file_name}")
        };
        if let Some(tid) = terminal_id {
            let attempt_started = AtomicBool::new(false);
            let handle = connect_russh_transfer_session(&app, tid, &state).await?;
            if let Err(error) = write_remote_file_atomic(
                &handle,
                &dest_path,
                &content,
                &app,
                &transfer_id,
                Some(&cancellation),
                &attempt_started,
            )
            .await
            {
                if attempt_started.load(Ordering::SeqCst) {
                    return Err(error);
                }
                invalidate_transfer_handle(&state, tid).await;
                if cancellation.load(Ordering::SeqCst) {
                    return Err("上传已取消".to_string());
                }
                let handle = interactive_remote_handle(&state, tid).await?;
                write_remote_file_atomic(
                    &handle,
                    &dest_path,
                    &content,
                    &app,
                    &transfer_id,
                    Some(&cancellation),
                    &attempt_started,
                )
                .await
                .map_err(|retry_err| format!("{error}; 重试失败: {retry_err}"))?;
            }
        } else {
            if cancellation.load(Ordering::SeqCst) {
                return Err("上传已取消".to_string());
            }
            let dest = PathBuf::from(&dest_path);
            fs::write(&dest, &content).map_err(|error| format!("写入本地文件失败：{error}"))?;
        }
        Ok(dest_path.clone())
    }
    .await;

    finish_transfer_cancellation(&state, &transfer_id, &cancellation).await;
    result
}

/// Stream-upload a local file to a remote directory by reading the file in
/// chunks on the Rust side and piping them through `cat > path` over SSH.
/// This avoids the front-end base64 encoding of large files (which blocks the
/// UI thread and causes progress to freeze) and avoids sending a huge base64
/// string through the Tauri IPC.
///
/// Emits "upload-progress" events with { transfer_id, transferred, total }.
#[tauri::command]
async fn upload_local_file(
    terminal_id: Uuid,
    local_path: String,
    dest_dir: String,
    transfer_id: String,
    remote_name: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let cancellation = register_transfer_cancellation(&state, &transfer_id).await;
    let result = async {
    if cancellation.load(Ordering::SeqCst) {
        return Err("上传已取消".to_string());
    }
    let local = PathBuf::from(&local_path);
    let local_file_name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    let file_name = remote_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(local_file_name);

    if file_name == "." || file_name == ".." || file_name.contains('/') || file_name.contains('\\') {
        return Err("远程文件名无效，不能使用路径分隔符、. 或 ..".to_string());
    }

    // Ensure the local path exists and is a regular file before streaming.
    let metadata = tokio::fs::metadata(&local)
        .await
        .map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !metadata.is_file() {
        return Err("只能上传普通文件".to_string());
    }

    let dest_path = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };

    let attempt_started = AtomicBool::new(false);
    let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
        if let Err(error) = stream_upload_file_atomic(
            &handle,
            &local,
            &dest_path,
            &transfer_id,
            &app,
            Some(&cancellation),
            &attempt_started,
        )
        .await
        {
            if attempt_started.load(Ordering::SeqCst) {
                return Err(error);
            }
            invalidate_transfer_handle(&state, terminal_id).await;
            if cancellation.load(Ordering::SeqCst) {
                return Err("上传已取消".to_string());
            }
            let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
            stream_upload_file_atomic(
                &handle,
                &local,
                &dest_path,
                &transfer_id,
                &app,
                Some(&cancellation),
                &attempt_started,
            )
            .await
            .map_err(|retry_err| format!("{error}; 重试失败: {retry_err}"))?;
        }
        Ok(dest_path.clone())
    }
    .await;

    finish_transfer_cancellation(&state, &transfer_id, &cancellation).await;
    result
}

/// 容忍中毒的 sysinfo 锁访问器：任一持锁路径 panic 后系统监控不应永久失效。
fn local_sys_monitor_guard(
    mutex: &std::sync::Mutex<Option<sysinfo::System>>,
) -> std::sync::MutexGuard<'_, Option<sysinfo::System>> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 确保本地 sysinfo 实例已初始化。CPU 占用需要相隔约 500ms 的两次采样才能
/// 得到有效增量；这里把等待放在锁外并以异步方式执行——既不在 std Mutex 内
/// 睡眠阻塞其它命令，也不占死 Tokio worker。
async fn ensure_local_sys_monitor(state: &AppState) {
    use sysinfo::{CpuRefreshKind, RefreshKind, System};

    let _init_guard = state.local_sys_monitor_init.lock().await;
    let needs_seed = {
        let mut guard = local_sys_monitor_guard(&state.local_sys_monitor);
        if guard.is_none() {
            // 先完成第一次数值采样，再放入共享槽成为“播种者”；等待期间不持锁
            let mut system = System::new_with_specifics(
                RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
            );
            system.refresh_cpu_usage();
            *guard = Some(system);
            true
        } else {
            false
        }
    };
    if needs_seed {
        // 第二次采样由当前调用方在等待结束后执行，确保返回值使用完整窗口
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}


/// Decide how many files to upload in parallel based on the local machine's
/// current CPU load: 1 when the CPU is busy, 2 when it's idle/free.
/// Reuses the cached `local_sys_monitor` so we don't spin up a fresh sysinfo
/// instance per upload. The threshold (60%) mirrors total CPU usage as shown
/// in Task Manager / top.
async fn recommended_upload_concurrency(state: &AppState) -> usize {
    const CPU_BUSY_THRESHOLD: f32 = 60.0;
    ensure_local_sys_monitor(state).await;
    let usage = match local_sys_monitor_guard(&state.local_sys_monitor).as_mut() {
        Some(s) => {
            s.refresh_cpu_usage();
            s.global_cpu_usage()
        }
        // 初始化竞态兜底：读不到采样按“空闲”处理，不阻塞上传流程
        None => 0.0,
    };
    if usage >= CPU_BUSY_THRESHOLD {
        1
    } else {
        2
    }
}

/// Suggested upload concurrency for the current machine (1 if CPU is busy,
/// 2 otherwise). The front-end calls this before a multi-file upload so its
/// worker pool matches local load.
#[tauri::command]
async fn get_upload_concurrency(state: State<'_, Arc<AppState>>) -> Result<usize, String> {
    Ok(recommended_upload_concurrency(&state).await)
}

/// Recursively upload a local directory to a remote server via SFTP/SSH.
/// Creates the directory structure on the remote, then uploads each file.
/// Returns the number of files uploaded and directories created.
#[tauri::command]
async fn upload_directory(
    terminal_id: Uuid,
    local_dir: String,
    dest_dir: String,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let cancellation = register_transfer_cancellation(&state, &transfer_id).await;

    let result = async {
    let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;

    let local_root = PathBuf::from(&local_dir);
    let dir_name = local_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法解析目录名".to_string())?;

    // Remote target: dest_dir/dir_name
    let remote_root = if dest_dir.ends_with('/') {
        format!("{dest_dir}{dir_name}")
    } else {
        format!("{dest_dir}/{dir_name}")
    };

    // Create the root directory on remote
    let quoted_root = shell_quote(&remote_root);
    let (_, stderr, code) = exec_remote_command_full(&handle, &format!("mkdir -p {quoted_root}")).await?;
    if code != Some(0) {
        return Err(format!("创建远程目录失败: {}", String::from_utf8_lossy(&stderr)));
    }

    let mut dirs_created: u64 = 1; // root dir already created
    let mut failed_items: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut file_jobs: Vec<(PathBuf, String, u64)> = Vec::new();

    // Walk the local directory tree: create remote directories and collect the
    // file jobs. The actual uploads run concurrently afterwards so the per-file
    // SSH round-trip latency is overlapped instead of being paid sequentially.
    // This is what makes uploading hundreds of tiny files fast (like XShell's
    // SFTP multi-file transfer).
    let mut dir_stack: Vec<(PathBuf, String)> = vec![(local_root.clone(), remote_root.clone())];
    // 记录已访问目录的真实目标（canonicalize 后）：目录符号链接 / Windows
    // Junction 成环时（如经典的自指环）若无此集合会无限展开、占满内存。
    let mut visited_dirs: std::collections::HashSet<PathBuf> =
        std::collections::HashSet::new();
    if let Ok(root_canonical) = local_root.canonicalize() {
        visited_dirs.insert(root_canonical);
    }

    while let Some((local_path, remote_path)) = dir_stack.pop() {
        if cancellation.load(Ordering::SeqCst) {
            return Err("上传已取消".to_string());
        }
        let entries = std::fs::read_dir(&local_path)
            .map_err(|e| format!("读取本地目录失败：{e}"))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("读取条目失败：{e}"))?;
            let entry_path = entry.path();
            let entry_name = entry.file_name().to_string_lossy().to_string();
            let remote_entry_path = format!("{remote_path}/{entry_name}");

            let file_type = entry
                .file_type()
                .map_err(|error| format!("读取条目类型失败：{error}"))?;
            // 符号链接（包括 Windows Junction）统一跳过：跟随链接可能造成目录环，
            // 而把链接目标当普通文件读取也会越出用户选择的上传目录。
            if file_type.is_symlink() {
                eprintln!("[Upload] skip symbolic link: {}", entry_path.display());
                continue;
            }
            if file_type.is_dir() {
                // 环检测：真实目标已见过则跳过（同时天然去重硬链接式重复子树）
                let canonical_dir = entry_path
                    .canonicalize()
                    .unwrap_or_else(|_| entry_path.clone());
                if !visited_dirs.insert(canonical_dir) {
                    eprintln!(
                        "[Upload] skip cyclic/duplicate directory: {}",
                        entry_path.display()
                    );
                    continue;
                }
                // Create remote subdirectory
                let quoted = shell_quote(&remote_entry_path);
                let (_, stderr, code) = exec_remote_command_full(&handle, &format!("mkdir -p {quoted}")).await?;
                if code != Some(0) {
                    failed_items.push(format!("目录 {entry_name}: {}", String::from_utf8_lossy(&stderr)));
                    continue;
                }
                dirs_created += 1;
                dir_stack.push((entry_path, remote_entry_path));
            } else {
                let metadata = tokio::fs::metadata(&entry_path)
                    .await
                    .map_err(|e| format!("读取文件信息失败：{e}"))?;
                total_bytes += metadata.len();
                file_jobs.push((entry_path, remote_entry_path, metadata.len()));
            }
        }
    }

    // Bounded concurrency on one reused transfer connection.
    let concurrency = recommended_upload_concurrency(&state).await.max(1);
    let semaphore = std::sync::Arc::new(Semaphore::new(concurrency));
    let mut tasks = Vec::with_capacity(file_jobs.len());

    emit_upload_progress(&app, &transfer_id, 0, total_bytes as usize);

    for (local_path, remote_entry_path, file_size) in file_jobs {
        if cancellation.load(Ordering::SeqCst) {
            return Err("上传已取消".to_string());
        }
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("信号量获取失败：{e}"))?;
        let handle = std::sync::Arc::clone(&handle);
        let app = app.clone();
        let cancellation = Arc::clone(&cancellation);
        let child_transfer_id = Uuid::new_v4().to_string();
        let task = tokio::spawn(async move {
            let _permit = permit;
            let attempt_started = AtomicBool::new(false);
            stream_upload_file_atomic(
                &handle,
                &local_path,
                &remote_entry_path,
                &child_transfer_id,
                &app,
                Some(&cancellation),
                &attempt_started,
            )
            .await
        });
        tasks.push((task, file_size));
    }

    let mut files_uploaded: u64 = 0;
    let mut uploaded_bytes: u64 = 0;
    for (task, file_size) in tasks {
        match task.await {
            Ok(Ok(())) => {
                files_uploaded += 1;
                uploaded_bytes += file_size;
                emit_upload_progress(
                    &app,
                    &transfer_id,
                    uploaded_bytes as usize,
                    total_bytes as usize,
                );
            }
            Ok(Err(e)) => {
                failed_items.push(e);
            }
            Err(e) => {
                failed_items.push(format!("上传任务异常：{e}"));
            }
        }
    }

    // Emit a final "directory-upload-complete" event
    let _ = app.emit(
        "directory-upload-complete",
        serde_json::json!({
            "local_dir": local_dir,
            "dest_dir": remote_root,
            "files_uploaded": files_uploaded,
            "dirs_created": dirs_created,
            "total_bytes": total_bytes,
            "failed_items": failed_items,
        }),
    );

    Ok(serde_json::json!({
        "remote_path": remote_root,
        "files_uploaded": files_uploaded,
        "dirs_created": dirs_created,
        "total_bytes": total_bytes,
        "failed_items": failed_items,
    }))
    }
    .await;

    finish_transfer_cancellation(&state, &transfer_id, &cancellation).await;
    result
}

/// Delete a file or directory (local or remote).
#[tauri::command]
async fn delete_path(
    terminal_id: Option<Uuid>,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let quoted = shell_quote(&path);
        let (_, stderr, code) = exec_remote_command_full(&handle, &format!("rm -rf {quoted}")).await?;
        if code != Some(0) {
            return Err(format!("删除失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        let p = PathBuf::from(&path);
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败：{e}"))?;
        } else {
            fs::remove_file(&p).map_err(|e| format!("删除文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// Create an empty file (local or remote).
#[tauri::command]
async fn create_file(
    terminal_id: Option<Uuid>,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let quoted = shell_quote(&path);
        let (_, stderr, code) = exec_remote_command_full(&handle, &format!("touch {quoted}")).await?;
        if code != Some(0) {
            return Err(format!("创建文件失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        let p = PathBuf::from(&path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败：{e}"))?;
        }
        fs::write(&p, b"").map_err(|e| format!("创建文件失败：{e}"))?;
    }
    Ok(())
}

/// Create a directory (local or remote).
#[tauri::command]
async fn create_directory(
    terminal_id: Option<Uuid>,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let quoted = shell_quote(&path);
        let (_, stderr, code) = exec_remote_command_full(&handle, &format!("mkdir -p {quoted}")).await?;
        if code != Some(0) {
            return Err(format!("创建目录失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        fs::create_dir_all(&path).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    Ok(())
}

fn destination_path(
    source: &str,
    dest_dir: &str,
    dest_name: Option<String>,
    remote: bool,
) -> Result<String, String> {
    if remote {
        let file_name = dest_name.unwrap_or_else(|| {
            source
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(source)
                .to_string()
        });
        if file_name.is_empty() {
            return Err("无法确定源文件名".to_string());
        }
        // 与本地分支同强度：目标名必须是单段名字。接受 `../x`、`a/b` 之类的
        // 多段值会把移动/复制目标指到任意远程路径，绕过所在目录约束。
        if file_name.contains('/') || file_name.contains('\0') || file_name == "." || file_name == ".."
        {
            return Err("目标名称不能包含路径分隔符".to_string());
        }
        return Ok(if dest_dir.ends_with('/') {
            format!("{dest_dir}{file_name}")
        } else {
            format!("{dest_dir}/{file_name}")
        });
    }

    let file_name = match dest_name {
        Some(name) if !name.trim().is_empty() => PathBuf::from(name),
        Some(_) => return Err("目标名称不能为空".to_string()),
        None => Path::new(source)
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| "无法确定源文件名".to_string())?,
    };
    if file_name.components().count() != 1 {
        return Err("目标名称不能包含路径分隔符".to_string());
    }

    Ok(format_path(PathBuf::from(dest_dir).join(file_name)))
}

/// Copy a file or directory into a destination directory.
/// If `dest_name` is provided, it overrides the source file name in the destination path.
#[tauri::command]
async fn copy_path(
    terminal_id: Option<Uuid>,
    source: String,
    dest_dir: String,
    dest_name: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let dest = destination_path(&source, &dest_dir, dest_name, terminal_id.is_some())?;

    // Nothing to do if source and destination are identical.
    if source == dest {
        return Ok(dest);
    }

    if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let sq = shell_quote(&source);
        let dq = shell_quote(&dest);
        let (_, stderr, code) = exec_remote_command_full(&handle, &format!("cp -r {sq} {dq}")).await?;
        if code != Some(0) {
            return Err(format!("复制失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        let src = PathBuf::from(&source);
        let dst = PathBuf::from(&dest);
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }
    Ok(dest)
}

/// Move/rename a file or directory into a destination directory.
/// If `dest_name` is provided, it overrides the source file name in the destination path.
#[tauri::command]
async fn move_path(
    terminal_id: Option<Uuid>,
    source: String,
    dest_dir: String,
    dest_name: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let dest = destination_path(&source, &dest_dir, dest_name, terminal_id.is_some())?;

    // Nothing to do if source and destination are identical (e.g. renaming
    // a file to its own name, or moving it into the directory it already lives in).
    if source == dest {
        return Ok(dest);
    }

    if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let sq = shell_quote(&source);
        let dq = shell_quote(&dest);
        let (_, stderr, code) = exec_remote_command_full(&handle, &format!("mv {sq} {dq}")).await?;
        if code != Some(0) {
            return Err(format!("移动失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        fs::rename(&source, &dest).map_err(|e| format!("移动文件失败：{e}"))?;
    }
    Ok(dest)
}

/// Recursively copy a directory (local only).
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败：{e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取条目失败：{e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// Guess a MIME type from a file extension for data-URL construction.
fn mime_from_ext(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".gif") { "image/gif" }
    else if lower.ends_with(".webp") { "image/webp" }
    else if lower.ends_with(".bmp") { "image/bmp" }
    else if lower.ends_with(".svg") { "image/svg+xml" }
    else if lower.ends_with(".ico") { "image/x-icon" }
    else if lower.ends_with(".mp4") { "video/mp4" }
    else if lower.ends_with(".webm") { "video/webm" }
    else if lower.ends_with(".ogg") || lower.ends_with(".ogv") { "video/ogg" }
    else if lower.ends_with(".mov") { "video/quicktime" }
    else if lower.ends_with(".avi") { "video/x-msvideo" }
    else if lower.ends_with(".mkv") { "video/x-matroska" }
    else if lower.ends_with(".mp3") { "audio/mpeg" }
    else if lower.ends_with(".wav") { "audio/wav" }
    else if lower.ends_with(".flac") { "audio/flac" }
    else { "application/octet-stream" }
}

/// Read a local or remote file as a `data:` URL so the webview can render
/// images / play video without additional asset-protocol configuration.
#[tauri::command]
async fn read_file_as_data_url(
    terminal_id: Option<Uuid>,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    const DATA_URL_LIMIT: u64 = 60 * 1024 * 1024; // 60 MB safety cap
    let mime = mime_from_ext(&path);

    let bytes = if let Some(tid) = terminal_id {
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let quoted = shell_quote(&path);
        let (size_out, size_stderr, size_code) = exec_remote_command_full(
            &handle,
            &format!("stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null"),
        )
        .await?;
        if size_code != Some(0) {
            return Err(format!(
                "远程媒体大小读取失败（退出码 {size_code:?}）：{}",
                String::from_utf8_lossy(&size_stderr).trim()
            ));
        }
        let size: u64 = String::from_utf8_lossy(&size_out).trim().parse().unwrap_or(0);
        if size > DATA_URL_LIMIT {
            return Err(format!("文件过大（{} 字节），媒体查看上限 {} 字节", size, DATA_URL_LIMIT));
        }
        let (bytes, stderr, exit_code) =
            exec_remote_command_full(&handle, &format!("cat {quoted}")).await?;
        if exit_code != Some(0) {
            return Err(format!(
                "远程媒体读取失败（退出码 {exit_code:?}）：{}",
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        bytes
    } else {
        let p = PathBuf::from(&path);
        let canonical = p.canonicalize().map_err(|e| format!("无法访问文件 {path}: {e}"))?;
        let meta = fs::metadata(&canonical).map_err(|e| format!("无法读取文件信息 {path}: {e}"))?;
        if meta.len() > DATA_URL_LIMIT {
            return Err(format!("文件过大（{} 字节），媒体查看上限 {} 字节", meta.len(), DATA_URL_LIMIT));
        }
        fs::read(&canonical).map_err(|e| format!("无法读取文件 {path}: {e}"))?
    };

    let encoded = base64_encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Download a remote file to a local directory.
#[tauri::command]
async fn download_remote_file(
    terminal_id: Uuid,
    remote_path: String,
    transfer_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let cancellation = register_transfer_cancellation(&state, &transfer_id).await;
    let result = async {
    const DOWNLOAD_LIMIT: u64 = 512 * 1024 * 1024; // 512 MB safety cap
    let local_dir = default_download_directory()?;

    async fn download_once(
        handle: &SharedRemoteHandle,
        remote_path: &str,
        local_dir: &Path,
        cancellation: &AtomicBool,
    ) -> Result<String, String> {
        let quoted = shell_quote(remote_path);

        // Portable size probe (GNU stat / BSD stat / wc fallback).
        let size_cmd = format!(
            "stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null || echo 0"
        );
        let (size_out, size_stderr, size_code) = exec_remote_command_full(handle, &size_cmd).await?;
        if size_code != Some(0) {
            return Err(format!(
                "读取远程文件大小失败（退出码 {size_code:?}）: {}",
                String::from_utf8_lossy(&size_stderr).trim()
            ));
        }
        let size: u64 = String::from_utf8_lossy(&size_out)
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if size > DOWNLOAD_LIMIT {
            return Err(format!(
                "文件过大（{} 字节），下载上限 {} 字节",
                size, DOWNLOAD_LIMIT
            ));
        }

        if cancellation.load(Ordering::SeqCst) {
            return Err("下载已取消".to_string());
        }
        let (bytes, stderr, code) = exec_remote_command_full_cancellable(
            handle,
            &format!("cat {quoted}"),
            cancellation,
        )
        .await?;
        if code != Some(0) {
            let detail = String::from_utf8_lossy(&stderr);
            return Err(format!("下载失败（退出码 {code:?}）: {}", detail.trim()));
        }
        if size > 0 && bytes.is_empty() {
            return Err("下载失败：远端返回空内容".to_string());
        }

        if cancellation.load(Ordering::SeqCst) {
            return Err("下载已取消".to_string());
        }
        let file_name = remote_path.rsplit('/').next().unwrap_or("download");
        let local_path = write_unique_local_file(local_dir, file_name, &bytes)?;
        Ok(local_path.to_string_lossy().to_string())
    }

    let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
    match download_once(&handle, &remote_path, &local_dir, &cancellation).await {
        Ok(path) => Ok(path),
        Err(error) => {
            invalidate_transfer_handle(&state, terminal_id).await;
            if cancellation.load(Ordering::SeqCst) {
                return Err("下载已取消".to_string());
            }
            let handle = connect_russh_transfer_session(&app, terminal_id, &state).await?;
            download_once(&handle, &remote_path, &local_dir, &cancellation)
                .await
                .map_err(|retry_err| format!("{error}; 重试失败: {retry_err}"))
        }
    }
    }
    .await;

    finish_transfer_cancellation(&state, &transfer_id, &cancellation).await;
    result
}

/// Extract an archive (local or remote) into the same directory.
#[tauri::command]
async fn extract_archive(
    terminal_id: Option<Uuid>,
    archive_path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let parent = std::path::Path::new(&archive_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    if let Some(tid) = terminal_id {
        // Remote (Unix) — use shell tools.
        let cmd = extract_command(&archive_path, &parent);
        if cmd.is_empty() {
            return Err("不支持的压缩包格式".to_string());
        }
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let (stdout, stderr, exit_code) = exec_remote_command_full(&handle, &cmd).await?;
        if exit_code != Some(0) {
            let detail = if !stderr.is_empty() {
                String::from_utf8_lossy(&stderr).to_string()
            } else if !stdout.is_empty() {
                String::from_utf8_lossy(&stdout).to_string()
            } else {
                format!("退出码: {exit_code:?}")
            };
            return Err(format!("远程解压失败: {detail}"));
        }
        let info = if !stdout.is_empty() {
            format!(": {}", String::from_utf8_lossy(&stdout))
        } else {
            String::new()
        };
        Ok(format!("解压完成{info}"))
    } else {
        // Local — platform-specific.
        extract_local_archive(&archive_path, &parent)
    }
}

/// Compress a file or directory into a zip archive next to the source.
#[tauri::command]
async fn create_archive(
    terminal_id: Option<Uuid>,
    source_path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    // Extract file name cross-platform (handles both / and \).
    let file_name = source_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&source_path);
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);

    if let Some(tid) = terminal_id {
        // Remote (Unix) — use zip.
        let parent = std::path::Path::new(&source_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let archive_path = format!("{}/{}.zip", parent.trim_end_matches('/'), stem);
        let q = shell_quote(&source_path);
        let aq = shell_quote(&archive_path);
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        let cmd = format!("rm -f {aq} && zip -r {aq} {q}");
        let (_stdout, stderr, exit_code) = exec_remote_command_full(&handle, &cmd).await?;
        if exit_code != Some(0) {
            let detail = if !stderr.is_empty() {
                String::from_utf8_lossy(&stderr).to_string()
            } else {
                format!("退出码: {exit_code:?}")
            };
            return Err(format!("远程压缩失败: {detail}"));
        }
        Ok(archive_path)
    } else {
        // Local — put archive next to the source.
        let source = PathBuf::from(&source_path);
        let parent = source
            .parent()
            .ok_or_else(|| "无法确定父目录".to_string())?;
        let archive_path = parent.join(format!("{}.zip", stem));

        let (program, args): (&str, Vec<String>) = if cfg!(windows) {
            (
                "powershell",
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!(
                        "Compress-Archive -Path '{}' -DestinationPath '{}' -Force",
                        source_path.replace('\'', "''"),
                        archive_path.to_string_lossy().replace('\'', "''")
                    ),
                ],
            )
        } else {
            // Unix 本地压缩：与远程分支一致使用 shell_quote 转义单引号，
            // 否则含 `'` 的文件名会闭合引号造成本地命令注入。
            (
                "sh",
                vec![
                    "-c".to_string(),
                    format!(
                        "rm -f {aq} && zip -r {aq} {q}",
                        aq = shell_quote(&archive_path.to_string_lossy()),
                        q = shell_quote(&source_path),
                    ),
                ],
            )
        };

        let output = std::process::Command::new(program)
            .args(&args)
            .output()
            .map_err(|e| format!("执行压缩失败（{program}）: {e}"))?;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                format!("退出码: {:?}", output.status.code())
            };
            return Err(format!("压缩失败（{program}）: {detail}"));
        }
        Ok(archive_path.to_string_lossy().to_string())
    }
}

/// Get the list of running processes sorted by CPU usage (descending).
/// Works for both local and remote (via SSH).
#[tauri::command]
async fn get_process_list(
    terminal_id: Option<Uuid>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ProcessInfo>, String> {
    if let Some(tid) = terminal_id {
        // Remote: execute via SSH
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };

        let (stdout, stderr, code) = exec_remote_command_full(&handle, system_monitor::PROCESS_LIST_CMD).await?;
        if code != Some(0) {
            return Err(format!("获取进程列表失败: {}", String::from_utf8_lossy(&stderr)));
        }
        Ok(system_monitor::parse_process_list(&String::from_utf8_lossy(&stdout)))
    } else {
        ensure_local_sys_monitor(&state).await;
        // 全量进程采集较耗时：放 blocking 线程池执行，避免占 tokio worker 与 SSH 读写争抢
        let app_state = Arc::clone(state.inner());
        let processes = tokio::task::spawn_blocking(move || {
            let mut guard = match app_state.local_sys_monitor.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            system_monitor::collect_local_processes(&mut guard)
        })
        .await
        .map_err(|e| format!("进程采样任务失败：{e}"))?;
        Ok(processes)
    }
}

/// Get system resource monitoring data (CPU, memory, disk, etc.).
/// Works for both local and remote (via SSH).
#[tauri::command]
async fn get_system_monitor(
    terminal_id: Option<Uuid>,
    state: State<'_, Arc<AppState>>,
) -> Result<SystemMonitorData, String> {
    if let Some(tid) = terminal_id {
        // Remote: execute monitoring commands via SSH
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };

        let (stdout, stderr, code) = exec_remote_command_full(&handle, system_monitor::SYSTEM_MONITOR_CMD).await?;
        if code != Some(0) {
            return Err(format!("获取系统监控数据失败: {}", String::from_utf8_lossy(&stderr)));
        }
        Ok(system_monitor::parse_system_monitor(&String::from_utf8_lossy(&stdout)))
    } else {
        ensure_local_sys_monitor(&state).await;
        // 磁盘/网络/进程全量采集较耗时：放 blocking 线程池，避免阻塞 tokio worker
        let app_state = Arc::clone(state.inner());
        let data = tokio::task::spawn_blocking(move || {
            let mut guard = match app_state.local_sys_monitor.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            system_monitor::collect_local_monitor(&mut guard)
        })
        .await
        .map_err(|e| format!("系统监控采样任务失败：{e}"))?;
        Ok(data)
    }
}

/// Get the local machine's primary IPv4 address by opening a UDP socket
/// "connected" to a public address (no packets are actually sent).
#[tauri::command]
async fn get_local_ipv4() -> Result<String, String> {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr().map(|a| a.ip().to_string())
        })
        .map_err(|e| format!("获取本地 IP 失败：{e}"))
}

#[tauri::command]
async fn local_terminal_profile_command() -> Result<LocalTerminalProfile, String> {
    Ok(local_terminal_profile())
}

#[tauri::command]
async fn local_terminal_start(
    request: LocalTerminalStartRequest,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<LocalTerminalProfile, String> {
    let canonical_cwd = resolve_local_path(request.cwd)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let cwd_str = format_path(canonical_cwd.clone());
    let cwd = PathBuf::from(&cwd_str);
    let terminal_id = Uuid::new_v4();
    let profile = LocalTerminalProfile {
        terminal_id: terminal_id.to_string(),
        os: std::env::consts::OS.to_string(),
        shell_name: local_shell_name().to_string(),
        cwd: format_path(cwd.clone()),
        prompt: String::new(),
        banner: Vec::new(),
    };

    eprintln!("[PTY] local_terminal_start: terminal_id={}, cwd={:?}", terminal_id, cwd);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(local_pty_size(request.cols, request.rows))
        .map_err(|error| {
            eprintln!("[PTY] openpty failed: {}", error);
            error.to_string()
        })?;
    let command = local_pty_command(&cwd);
    eprintln!("[PTY] spawning command for terminal_id={}", terminal_id);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| {
            eprintln!("[PTY] spawn_command failed: {}", error);
            error.to_string()
        })?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| {
            eprintln!("[PTY] try_clone_reader failed: {}", error);
            error.to_string()
        })?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| {
            eprintln!("[PTY] take_writer failed: {}", error);
            error.to_string()
        })?;

    let shared_writer = Arc::new(std::sync::Mutex::new(writer));
    let cleanup_state = Arc::clone(state.inner());

    let mut terminals = state.local_terminals.lock().await;
    terminals.insert(
        terminal_id,
        LocalTerminalSession {
            master: pair.master,
            writer: Arc::clone(&shared_writer),
            child,
        },
    );
    drop(terminals);

    emit_terminal_status(
        &app,
        terminal_id.to_string(),
        TerminalTransport::Local,
        TerminalLifecycleState::Connected,
        None,
    );
    eprintln!("[PTY] PTY setup complete, spawning reader for terminal_id={}", terminal_id);
    spawn_terminal_reader(app, terminal_id, reader, shared_writer, cleanup_state);

    Ok(profile)
}

#[tauri::command]
async fn local_terminal_input(
    request: LocalTerminalInputRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut terminals = state.local_terminals.lock().await;
    let session = terminals
        .get_mut(&request.terminal_id)
        .ok_or_else(|| "本地终端尚未启动".to_string())?;

    let writer = Arc::clone(&session.writer);
    drop(terminals);
    let mut guard = writer
        .lock()
        .map_err(|_| "writer lock failed".to_string())?;
    guard
        .write_all(request.data.as_bytes())
        .map_err(|error| error.to_string())?;
    guard.flush().map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_terminal_resize(
    request: LocalTerminalResizeRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut terminals = state.local_terminals.lock().await;
    let Some(session) = terminals.get_mut(&request.terminal_id) else {
        return Ok(());
    };

    session
        .master
        .resize(local_pty_size(Some(request.cols), Some(request.rows)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_terminal_stop(
    terminal_id: Uuid,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let session = {
        let mut terminals = state.local_terminals.lock().await;
        take_terminal_session(&mut terminals, terminal_id)
    };
    if let Some(mut session) = session {
        let cleanup_result = tauri::async_runtime::spawn_blocking(move || {
            let kill_error = session.child.kill().err();
            session.child.wait().map_err(|wait_error| match kill_error {
                Some(kill_error) => format!("终止终端失败：{kill_error}；等待退出失败：{wait_error}"),
                None => format!("等待终端退出失败：{wait_error}"),
            })?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|error| error.to_string())?;

        emit_terminal_status(
            &app,
            terminal_id.to_string(),
            TerminalTransport::Local,
            TerminalLifecycleState::Disconnected,
            None,
        );
        cleanup_result?;
    }
    Ok(())
}

#[tauri::command]
async fn local_terminal_write(
    request: LocalTerminalWriteRequest,
    _state: State<'_, Arc<AppState>>,
) -> Result<LocalTerminalWriteResponse, String> {
    let command = request.data.trim();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }

    let cwd = resolve_local_path(request.cwd)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if is_clear_command(command) {
        return Ok(LocalTerminalWriteResponse {
            event: TerminalEvent {
                session_id: Uuid::nil(),
                kind: TerminalEventKind::Output,
                payload: String::new(),
            },
            cwd: Some(format_path(cwd.clone())),
            prompt: local_prompt(&cwd),
            clear: true,
        });
    }

    let (body, next_cwd, success) = run_local_shell_command(command, &cwd).await?;
    let resolved_cwd = next_cwd.unwrap_or_else(|| format_path(cwd.clone()));
    let next_prompt = local_prompt(Path::new(&resolved_cwd));

    Ok(LocalTerminalWriteResponse {
        event: TerminalEvent {
            session_id: Uuid::nil(),
            kind: if success {
                TerminalEventKind::Output
            } else {
                TerminalEventKind::Error
            },
            payload: body,
        },
        cwd: Some(resolved_cwd),
        prompt: next_prompt,
        clear: false,
    })
}

fn prepare_session_for_save(
    request: SaveSessionRequest,
    existing: Option<&Session>,
    credentials: &mut CredentialVaultState,
) -> Result<Session, String> {
    let SaveSessionRequest {
        mut session,
        secret,
        passphrase,
    } = request;

    match &mut session.auth {
        AuthType::Password { secret_id } => {
            let id = credential_id(session.id, "password");
            if let Some(value) = secret.filter(|value| !value.is_empty()) {
                *secret_id = store_credential(credentials, id, &value)?;
            } else if let Some(AuthType::Password {
                secret_id: existing_id,
            }) = existing.map(|item| &item.auth)
            {
                *secret_id = existing_id.clone();
            } else {
                return Err("密码不能为空".to_string());
            }
        }
        AuthType::KeyboardInteractive { response_secret_id } => {
            let id = credential_id(session.id, "keyboard-interactive");
            if let Some(value) = secret.filter(|value| !value.is_empty()) {
                *response_secret_id = store_credential(credentials, id, &value)?;
            } else if let Some(AuthType::KeyboardInteractive {
                response_secret_id: existing_id,
            }) = existing.map(|item| &item.auth)
            {
                *response_secret_id = existing_id.clone();
            } else {
                return Err("交互提示响应不能为空".to_string());
            }
        }
        AuthType::PrivateKey {
            passphrase_secret_id,
            ..
        } => {
            let id = credential_id(session.id, "private-key-passphrase");
            if let Some(value) = passphrase.filter(|value| !value.is_empty()) {
                *passphrase_secret_id = Some(store_credential(credentials, id, &value)?);
            } else if let Some(AuthType::PrivateKey {
                passphrase_secret_id: existing_id,
                ..
            }) = existing.map(|item| &item.auth)
            {
                *passphrase_secret_id = existing_id.clone();
            } else {
                *passphrase_secret_id = None;
            }
        }
        AuthType::Agent | AuthType::Gssapi { .. } => {}
    }

    Ok(session)
}

fn session_credential_ids(session: &Session) -> Vec<&str> {
    match &session.auth {
        AuthType::Password { secret_id } => vec![secret_id.as_str()],
        AuthType::KeyboardInteractive { response_secret_id } => {
            vec![response_secret_id.as_str()]
        }
        AuthType::PrivateKey {
            passphrase_secret_id: Some(passphrase),
            ..
        } => vec![passphrase.as_str()],
        AuthType::PrivateKey {
            passphrase_secret_id: None,
            ..
        }
        | AuthType::Agent
        | AuthType::Gssapi { .. } => Vec::new(),
    }
}

fn remove_session_credentials(vault: &mut CredentialVault, session: &Session) {
    for id in session_credential_ids(session) {
        vault.entries.remove(id);
    }
}

fn apply_ai_provider_auth(
    builder: reqwest::RequestBuilder,
    api_format: &str,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    let Some(key) = api_key.filter(|value| !value.is_empty()) else {
        return builder;
    };
    if is_claude_api_format(api_format) {
        builder
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
    } else {
        builder.bearer_auth(key)
    }
}

/// 将内部 chat 消息转为 Anthropic Messages 请求体
fn build_claude_messages_payload(
    model: &str,
    messages: &[AiChatMessage],
    stream: bool,
    max_tokens: u32,
) -> Result<Value, String> {
    let mut system_parts: Vec<String> = Vec::new();
    let mut claude_messages: Vec<Value> = Vec::new();
    for message in messages {
        let role = message.role.trim().to_ascii_lowercase();
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        match role.as_str() {
            "system" => system_parts.push(content.to_string()),
            "user" | "assistant" => {
                // Anthropic 要求 user/assistant 交替；连续同角色时合并
                if let Some(last) = claude_messages.last_mut() {
                    if last.get("role").and_then(|v| v.as_str()) == Some(role.as_str()) {
                        if let Some(existing) = last.get("content").and_then(|v| v.as_str()) {
                            let merged = format!("{existing}\n\n{content}");
                            last["content"] = Value::String(merged);
                            continue;
                        }
                    }
                }
                claude_messages.push(serde_json::json!({
                    "role": role,
                    "content": content,
                }));
            }
            _ => {
                return Err(format!("Claude 格式暂不支持消息角色：{role}"));
            }
        }
    }
    if claude_messages.is_empty() {
        return Err("Claude 请求缺少 user/assistant 消息".to_string());
    }
    // 必须以 user 开头
    if claude_messages
        .first()
        .and_then(|item| item.get("role"))
        .and_then(|v| v.as_str())
        != Some("user")
    {
        claude_messages.insert(
            0,
            serde_json::json!({
                "role": "user",
                "content": "(continue)",
            }),
        );
    }
    let mut payload = serde_json::json!({
        "model": model,
        // Claude Messages API 必须带 max_tokens：未配置时沿用历史兜底值
        "max_tokens": if max_tokens == 0 { AI_CLAUDE_FALLBACK_MAX_TOKENS } else { max_tokens },
        "stream": stream,
        "messages": claude_messages,
    });
    if !system_parts.is_empty() {
        payload["system"] = Value::String(system_parts.join("\n\n"));
    }
    Ok(payload)
}

/// 判断 Claude SSE 事件是否为 message_stop。
///
/// 必须解析 JSON 的 `type` 字段而非对原文做子串匹配：模型正文中完全可以
/// 出现字面量 "message_stop"（例如讲解流式协议时），子串匹配会把正常回答
/// 误判为流结束并截断后续内容。
fn is_claude_stop_event(data: &str) -> bool {
    serde_json::from_str::<Value>(data)
        .ok()
        .is_some_and(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|event_type| event_type == "message_stop")
        })
}

fn extract_claude_text_content(body: &Value) -> Option<String> {
    let content = body.get("content")?.as_array()?;
    let mut parts = Vec::new();
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
}

fn extract_claude_stream_delta(data: &str) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_str(data)
        .map_err(|error| format!("Claude 流式响应格式不兼容：{error}"))?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "content_block_delta" => {
            let text = value
                .pointer("/delta/text")
                .and_then(|v| v.as_str())
                .filter(|t| !t.is_empty())
                .map(ToString::to_string);
            Ok(text)
        }
        "error" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Claude 流式错误");
            Err(message.to_string())
        }
        _ => Ok(None),
    }
}

fn ai_config_snapshot(
    config: &AiProviderConfigStore,
    api_key: Option<String>,
    error: Option<String>,
) -> Result<AiProviderConfig, String> {
    let active = find_ai_account(config, None)?;
    let accounts = config
        .accounts
        .iter()
        .map(|item| AiProviderAccountView {
            id: item.id.clone(),
            name: item.name.clone(),
            base_url: item.base_url.clone(),
            model: item.model.clone(),
            api_format: item.api_format.clone(),
            api_key_configured: item.api_key_secret_id.is_some(),
        })
        .collect();
    Ok(AiProviderConfig {
        account_id: active.id.clone(),
        account_name: active.name.clone(),
        base_url: active.base_url.clone(),
        model: active.model.clone(),
        models: active.models.clone(),
        enabled_models: active.enabled_models.clone(),
        reasoning_effort: config.reasoning_effort.clone(),
        api_format: active.api_format.clone(),
        context_window: active.context_window,
        max_tokens: active.max_tokens,
        use_api_key: active.use_api_key,
        api_key_configured: active.api_key_secret_id.is_some(),
        api_key,
        accounts,
        active_account_id: config.active_account_id.clone(),
        error,
    })
}

fn resolve_ai_api_key(
    credentials: &CredentialVaultState,
    secret_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(secret_id) = secret_id else {
        return Ok(None);
    };
    Ok(Some(resolve_credential(credentials, secret_id)?))
}

fn parse_openai_model_ids(body: &str) -> Result<Vec<String>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| format!("模型列表响应格式不兼容：{error}"))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "模型列表响应缺少 data 数组".to_string())?;
    let mut models = Vec::new();
    for item in data {
        let id = item
            .as_str()
            .map(str::to_string)
            .or_else(|| item.get("id").and_then(Value::as_str).map(str::to_string));
        let Some(id) = id else {
            continue;
        };
        if validate_ai_model(&id).is_ok() && !models.iter().any(|model| model == &id) {
            models.push(id);
        }
        if models.len() >= MAX_AI_MODELS {
            break;
        }
    }
    if models.is_empty() {
        return Err("模型列表为空".to_string());
    }
    Ok(models)
}

fn validate_ai_messages(messages: &[AiChatMessage]) -> Result<(), String> {
    if messages.is_empty() {
        return Err("对话消息不能为空".to_string());
    }
    if messages.len() > MAX_AI_MESSAGES {
        return Err(format!("对话消息不能超过 {MAX_AI_MESSAGES} 条"));
    }
    let mut total_chars = 0usize;
    for message in messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
            return Err("对话消息角色无效".to_string());
        }
        let chars = message.content.chars().count();
        if chars == 0 || chars > MAX_AI_MESSAGE_CHARS {
            return Err(format!("单条消息必须为 1 到 {MAX_AI_MESSAGE_CHARS} 个字符"));
        }
        total_chars = total_chars.saturating_add(chars);
    }
    if total_chars > MAX_AI_TOTAL_CHARS {
        return Err(format!("对话内容不能超过 {MAX_AI_TOTAL_CHARS} 个字符"));
    }
    Ok(())
}

fn extract_ai_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_string());
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.trim().is_empty()).then_some(text)
}

/// Agent 模式注入的固定 OpenAI tools；前端映射为待授权动作卡，不在后端直接执行。
fn agent_openai_tools() -> Vec<Value> {
    vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "run_terminal_command",
                "description": "Propose ONE non-interactive terminal command for authorization. Creates a pending card only; does NOT execute until approved (or low-risk auto-run). Prefer tools over describing commands in prose.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": "Short action summary shown on the approval card"
                        },
                        "context_source": {
                            "type": "string",
                            "description": "Exact source field from workspace_context_json for the target terminal (usually terminal:sessionId-uuid). Do not invent placeholders like terminal/current/active."
                        },
                        "command": {
                            "type": "string",
                            "description": "One-shot non-interactive shell command. Keep a space before shell redirections (e.g. nginx -T 2>/dev/null)."
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "description": "Timeout in milliseconds (3000-30000). Default 10000."
                        }
                    },
                    "required": ["summary", "context_source", "command"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "call_mcp_tool",
                "description": "Propose ONE MCP tool call for authorization. Creates a pending card only; does NOT call until approved (or low-risk auto-run). Use exact server/tool names from the catalog.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": "Short action summary shown on the approval card"
                        },
                        "server": {
                            "type": "string",
                            "description": "MCP server id from the connected tools catalog"
                        },
                        "tool": {
                            "type": "string",
                            "description": "MCP tool name from the connected tools catalog"
                        },
                        "arguments": {
                            "type": "object",
                            "description": "JSON object arguments for the MCP tool"
                        }
                    },
                    "required": ["summary", "server", "tool"]
                }
            }
        }),
    ]
}

fn apply_stream_tool_call_delta(
    builders: &mut HashMap<usize, StreamToolCallBuilder>,
    delta: OpenAiStreamToolCallDelta,
) {
    let entry = builders.entry(delta.index).or_default();
    if let Some(id) = delta.id.filter(|value| !value.is_empty()) {
        entry.id = id;
    }
    if let Some(function) = delta.function {
        if let Some(name) = function.name.filter(|value| !value.is_empty()) {
            entry.name = name;
        }
        if let Some(arguments) = function.arguments {
            entry.arguments.push_str(&arguments);
        }
    }
}

fn finalize_stream_tool_calls(
    builders: HashMap<usize, StreamToolCallBuilder>,
) -> Vec<AiToolCall> {
    let mut ordered = builders.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    ordered
        .into_iter()
        .filter_map(|(_, builder)| {
            let name = builder.name.trim();
            if name.is_empty() {
                return None;
            }
            Some(AiToolCall {
                id: if builder.id.trim().is_empty() {
                    format!("call_{}", Uuid::new_v4())
                } else {
                    builder.id
                },
                name: name.to_string(),
                arguments: builder.arguments,
            })
        })
        .collect()
}

fn extract_provider_error(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| body.chars().take(500).collect::<String>())
}

#[tauri::command]
async fn get_ai_provider_config(
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    let config = state.ai_config.lock().await.clone();
    let error = state.ai_config_error.lock().await.clone();
    let active = find_ai_account(&config, None)?;
    let credentials = state.credentials.lock().await;
    let api_key = match resolve_ai_api_key(&credentials, active.api_key_secret_id.as_deref()) {
        Ok(key) => key,
        Err(reveal_error) => {
            eprintln!("[AI] reveal api key failed: {reveal_error}");
            None
        }
    };
    ai_config_snapshot(&config, api_key, error)
}

#[tauri::command]
async fn save_ai_provider_config(
    request: SaveAiProviderConfigRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let base_url = validate_ai_base_url(&request.base_url)?.to_string();
    let model = validate_ai_model(&request.model)?;
    let supplied_key = request.api_key.filter(|key| !key.trim().is_empty());
    let mut current = state.ai_config.lock().await.clone();
    let account_id = request
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(current.active_account_id.as_str())
        .to_string();
    let existing = find_ai_account(&current, Some(&account_id))?;
    if request.use_api_key && supplied_key.is_none() && existing.api_key_secret_id.is_none() {
        return Err("启用 API Key 时必须输入密钥".to_string());
    }
    let models = normalize_ai_models(
        request.models.as_deref().unwrap_or(&existing.models),
        &model,
    )?;
    let enabled_models = normalize_enabled_ai_models(
        &models,
        request
            .enabled_models
            .as_deref()
            .unwrap_or(&existing.enabled_models),
        &model,
    )?;
    let reasoning_effort = validate_ai_reasoning_effort(
        request
            .reasoning_effort
            .as_deref()
            .unwrap_or(&current.reasoning_effort),
    )?;
    let api_format = validate_ai_api_format(
        request
            .api_format
            .as_deref()
            .unwrap_or(&existing.api_format),
    )?;
    let account_name = normalize_ai_account_name(
        request
            .account_name
            .as_deref()
            .unwrap_or(&existing.name),
    );
    let context_window = validate_ai_context_window(
        request.context_window.unwrap_or(existing.context_window),
    )?;
    let max_tokens = validate_ai_max_tokens(request.max_tokens.unwrap_or(existing.max_tokens))?;
    let old_secret_id = existing.api_key_secret_id.clone();

    let mut credentials = state.credentials.lock().await;
    let next_secret_id = if let Some(key) = supplied_key.as_deref() {
        let id = format!("{AI_API_KEY_PREFIX}:{}", Uuid::new_v4());
        Some(store_credential(&mut credentials, id, key.trim())?)
    } else if request.use_api_key {
        old_secret_id.clone()
    } else {
        None
    };

    {
        let account = find_ai_account_mut(&mut current, Some(&account_id))?;
        account.name = account_name;
        account.base_url = base_url;
        account.model = model;
        account.models = models;
        account.enabled_models = enabled_models;
        account.api_format = api_format;
        account.context_window = context_window;
        account.max_tokens = max_tokens;
        account.use_api_key = request.use_api_key;
        account.api_key_secret_id = next_secret_id.clone();
    }
    current.active_account_id = account_id;
    current.reasoning_effort = reasoning_effort;
    current.version = AI_CONFIG_VERSION;
    normalize_ai_config_store(&mut current)?;

    if next_secret_id != old_secret_id {
        save_credential_vault(&credentials.vault)?;
    }
    save_ai_config(&current)?;
    if let Some(old_id) = old_secret_id.filter(|old_id| Some(old_id) != next_secret_id.as_ref()) {
        credentials.vault.entries.remove(&old_id);
        if let Err(error) = save_credential_vault(&credentials.vault) {
            eprintln!("[Credential] obsolete AI API key cleanup deferred: {error}");
        }
    }
    let api_key = if let Some(key) = supplied_key {
        Some(key.trim().to_string())
    } else {
        let active = find_ai_account(&current, None)?;
        resolve_ai_api_key(&credentials, active.api_key_secret_id.as_deref())?
    };
    *state.ai_config.lock().await = current.clone();
    ai_config_snapshot(&current, api_key, None)
}

#[tauri::command]
async fn add_ai_provider_account(
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let mut current = state.ai_config.lock().await.clone();
    if current.accounts.len() >= MAX_AI_ACCOUNTS {
        return Err(format!("AI 账号数量不能超过 {MAX_AI_ACCOUNTS}"));
    }
    let index = current.accounts.len() + 1;
    let account = AiProviderAccountStore {
        id: Uuid::new_v4().to_string(),
        name: format!("账号 {index}"),
        base_url: DEFAULT_AI_BASE_URL.to_string(),
        model: DEFAULT_AI_MODEL.to_string(),
        models: vec![DEFAULT_AI_MODEL.to_string()],
        enabled_models: vec![DEFAULT_AI_MODEL.to_string()],
        api_format: DEFAULT_AI_API_FORMAT.to_string(),
        context_window: DEFAULT_AI_CONTEXT_WINDOW,
        max_tokens: DEFAULT_AI_MAX_TOKENS,
        use_api_key: true,
        api_key_secret_id: None,
    };
    current.active_account_id = account.id.clone();
    current.accounts.push(account);
    current.version = AI_CONFIG_VERSION;
    normalize_ai_config_store(&mut current)?;
    save_ai_config(&current)?;
    *state.ai_config.lock().await = current.clone();
    ai_config_snapshot(&current, None, None)
}

#[tauri::command]
async fn delete_ai_provider_account(
    request: AiAccountIdRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let account_id = request.account_id.trim().to_string();
    if account_id.is_empty() {
        return Err("账号 id 不能为空".to_string());
    }
    let mut current = state.ai_config.lock().await.clone();
    if current.accounts.len() <= 1 {
        return Err("至少保留一个 AI 账号".to_string());
    }
    let removed = find_ai_account(&current, Some(&account_id))?.clone();
    current.accounts.retain(|item| item.id != account_id);
    if current.active_account_id == account_id {
        current.active_account_id = current.accounts[0].id.clone();
    }
    current.version = AI_CONFIG_VERSION;
    normalize_ai_config_store(&mut current)?;
    save_ai_config(&current)?;
    if let Some(secret_id) = removed.api_key_secret_id {
        let mut credentials = state.credentials.lock().await;
        credentials.vault.entries.remove(&secret_id);
        if let Err(error) = save_credential_vault(&credentials.vault) {
            eprintln!("[Credential] deleted AI account key cleanup deferred: {error}");
        }
    }
    *state.ai_config.lock().await = current.clone();
    let active = find_ai_account(&current, None)?;
    let credentials = state.credentials.lock().await;
    let api_key = resolve_ai_api_key(&credentials, active.api_key_secret_id.as_deref())?;
    ai_config_snapshot(&current, api_key, None)
}

#[tauri::command]
async fn set_active_ai_provider_account(
    request: AiAccountIdRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let account_id = request.account_id.trim().to_string();
    let mut current = state.ai_config.lock().await.clone();
    find_ai_account(&current, Some(&account_id))?;
    current.active_account_id = account_id;
    current.version = AI_CONFIG_VERSION;
    save_ai_config(&current)?;
    *state.ai_config.lock().await = current.clone();
    let active = find_ai_account(&current, None)?;
    let credentials = state.credentials.lock().await;
    let api_key = match resolve_ai_api_key(&credentials, active.api_key_secret_id.as_deref()) {
        Ok(key) => key,
        Err(reveal_error) => {
            eprintln!("[AI] reveal api key failed: {reveal_error}");
            None
        }
    };
    ai_config_snapshot(&current, api_key, None)
}

#[tauri::command]
async fn sync_ai_provider_models(
    request: SyncAiModelsRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let mut current = state.ai_config.lock().await.clone();
    let account_id = request
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(current.active_account_id.as_str())
        .to_string();
    let existing = find_ai_account(&current, Some(&account_id))?.clone();
    let base_url = validate_ai_base_url(
        request
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&existing.base_url),
    )?
    .to_string();
    let use_api_key = request.use_api_key.unwrap_or(existing.use_api_key);
    let supplied_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToString::to_string);
    let api_key = if use_api_key {
        if let Some(key) = supplied_key {
            Some(Zeroizing::new(key))
        } else {
            let secret_id = existing
                .api_key_secret_id
                .as_deref()
                .ok_or_else(|| "尚未配置 AI API Key".to_string())?;
            let credentials = state.credentials.lock().await;
            Some(Zeroizing::new(resolve_credential(&credentials, secret_id)?))
        }
    } else {
        None
    };

    let endpoint = ai_models_url(&base_url)?;
    let format_for_auth = if let Some(raw) = request.api_format.as_deref() {
        validate_ai_api_format(raw)?
    } else {
        existing.api_format.clone()
    };
    let mut builder = state.ai_http.get(endpoint).timeout(AI_HTTP_REQUEST_TIMEOUT);
    builder = apply_ai_provider_auth(builder, &format_for_auth, api_key.as_ref().map(|value| value.as_str()));
    let response = builder
        .send()
        .await
        .map_err(|error| format!("同步模型列表失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("模型列表响应读取失败：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "模型列表返回 HTTP {}：{}",
            status.as_u16(),
            extract_provider_error(&body)
        ));
    }
    let synced = parse_openai_model_ids(&body)?;
    let models = normalize_ai_models(&merge_ai_models(&existing.models, &synced)?, &existing.model)?;
    let enabled_models =
        normalize_enabled_ai_models(&models, &existing.enabled_models, &existing.model)?;
    {
        let account = find_ai_account_mut(&mut current, Some(&account_id))?;
        account.models = models;
        account.enabled_models = enabled_models;
    }
    current.version = AI_CONFIG_VERSION;
    save_ai_config(&current)?;
    *state.ai_config.lock().await = current.clone();
    let revealed = api_key.as_ref().map(|key| key.as_str().to_string());
    ai_config_snapshot(&current, revealed, None)
}

#[tauri::command]
async fn get_mcp_config(
    state: State<'_, Arc<AppState>>,
) -> Result<mcp::McpConfigSnapshot, String> {
    let store = state.mcp_config.lock().await.clone();
    let error = state.mcp_config_error.lock().await.clone();
    let path = mcp_config_file_path()?
        .to_string_lossy()
        .into_owned();
    Ok(state.mcp_runtime.snapshot(&store, error, path).await)
}

#[tauri::command]
async fn save_mcp_config(
    request: mcp::SaveMcpConfigRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<mcp::McpConfigSnapshot, String> {
    if let Some(error) = state.mcp_config_error.lock().await.clone() {
        return Err(error);
    }
    let servers = mcp::normalize_mcp_servers(request.servers)?;
    let next = mcp::McpConfigStore {
        version: mcp::MCP_CONFIG_VERSION,
        servers,
    };
    let path = mcp_config_file_path()?;
    mcp::save_mcp_config(&path, &next)?;
    *state.mcp_config.lock().await = next.clone();
    state.mcp_runtime.sync_enabled_servers(&next).await;
    Ok(state
        .mcp_runtime
        .snapshot(&next, None, path.to_string_lossy().into_owned())
        .await)
}

#[tauri::command]
async fn reconnect_mcp_server(
    server_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<mcp::McpConfigSnapshot, String> {
    if let Some(error) = state.mcp_config_error.lock().await.clone() {
        return Err(error);
    }
    let store = state.mcp_config.lock().await.clone();
    let server = store
        .servers
        .iter()
        .find(|item| item.id == server_id)
        .ok_or_else(|| format!("未找到 MCP 服务器：{server_id}"))?
        .clone();
    // 连接失败仍返回快照，让 UI 展示 error 状态；失败也要留痕便于排查
    if let Err(error) = state.mcp_runtime.connect_server(&server).await {
        eprintln!("[MCP] reconnect failed for {server_id}: {error}");
    }
    let path = mcp_config_file_path()?
        .to_string_lossy()
        .into_owned();
    Ok(state.mcp_runtime.snapshot(&store, None, path).await)
}

#[tauri::command]
async fn list_mcp_tools(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<serde_json::Value>, String> {
    if let Some(error) = state.mcp_config_error.lock().await.clone() {
        return Err(error);
    }
    let store = state.mcp_config.lock().await.clone();
    Ok(state.mcp_runtime.list_tools_catalog(&store).await)
}

#[tauri::command]
async fn call_mcp_tool(
    request: mcp::CallMcpToolRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<mcp::CallMcpToolResult, String> {
    if let Some(error) = state.mcp_config_error.lock().await.clone() {
        return Err(error);
    }
    let store = state.mcp_config.lock().await.clone();
    state.mcp_runtime.call_tool(&store, request).await
}

#[tauri::command]
fn list_mcp_import_candidates() -> Vec<mcp::McpImportCandidate> {
    mcp::list_mcp_import_candidates()
}

/// 从 Cursor / Claude 风格 mcp.json 解析服务器列表（不落盘；前端合并到草稿）。
#[tauri::command]
fn import_mcp_servers_from_path(path: String) -> Result<mcp::McpImportPreview, String> {
    mcp::import_mcp_servers_from_path(&path)
}

/// 导出当前草稿为 Cursor mcpServers JSON（不落盘）。
#[tauri::command]
fn export_mcp_servers_cursor_json(
    servers: Vec<mcp::McpServerConfig>,
) -> Result<String, String> {
    mcp::export_mcp_servers_cursor_json(&servers)
}

#[tauri::command]
async fn ai_chat(
    request: AiChatRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiChatResponse, String> {
    validate_ai_messages(&request.messages)?;
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let config = state.ai_config.lock().await.clone();
    let account = find_ai_account(&config, None)?.clone();
    let endpoint = ai_chat_endpoint(&account.base_url, &account.api_format)?;
    let api_key = if account.use_api_key {
        let secret_id = account
            .api_key_secret_id
            .as_deref()
            .ok_or_else(|| "尚未配置 AI API Key".to_string())?;
        let credentials = state.credentials.lock().await;
        Some(Zeroizing::new(resolve_credential(&credentials, secret_id)?))
    } else {
        None
    };

    let mut builder = state.ai_http.post(endpoint).timeout(AI_HTTP_REQUEST_TIMEOUT);
    builder = apply_ai_provider_auth(builder, &account.api_format, api_key.as_ref().map(|value| value.as_str()));
    let builder = if is_claude_api_format(&account.api_format) {
        let payload =
            build_claude_messages_payload(&account.model, &request.messages, false, account.max_tokens)?;
        builder.json(&payload)
    } else {
        let payload = OpenAiChatRequest {
            model: &account.model,
            messages: &request.messages,
            max_tokens: ai_request_max_tokens(account.max_tokens),
            reasoning_effort: ai_request_reasoning_effort(&config.reasoning_effort),
        };
        builder.json(&payload)
    };
    let response = builder
        .send()
        .await
        .map_err(|error| format!("AI 供应商请求失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("AI 供应商响应读取失败：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "AI 供应商返回 HTTP {}：{}",
            status.as_u16(),
            extract_provider_error(&body)
        ));
    }
    if is_claude_api_format(&account.api_format) {
        let value: Value = serde_json::from_str(&body)
            .map_err(|error| format!("AI 供应商响应格式不兼容：{error}"))?;
        let content = extract_claude_text_content(&value)
            .ok_or_else(|| "AI 供应商响应中没有可用文本".to_string())?;
        let model = value
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(&account.model)
            .to_string();
        return Ok(AiChatResponse { content, model });
    }
    let response: OpenAiChatResponse = serde_json::from_str(&body)
        .map_err(|error| format!("AI 供应商响应格式不兼容：{error}"))?;
    let content = response
        .choices
        .first()
        .and_then(|choice| extract_ai_content(&choice.message.content))
        .ok_or_else(|| "AI 供应商响应中没有可用文本".to_string())?;
    Ok(AiChatResponse {
        content,
        model: response.model.unwrap_or(account.model),
    })
}

/// 用草稿配置流式探测连通性：发 “hi”，统计首字/总耗时（不修改已保存配置）
#[tauri::command]
async fn test_ai_provider(
    request: TestAiProviderRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<TestAiProviderResponse, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let base_url = validate_ai_base_url(&request.base_url)?.to_string();
    let model = validate_ai_model(&request.model)?;
    let current = state.ai_config.lock().await.clone();
    let active = find_ai_account(&current, None)?;
    let api_format = validate_ai_api_format(
        request
            .api_format
            .as_deref()
            .unwrap_or(&active.api_format),
    )?;
    let use_api_key = request.use_api_key.unwrap_or(true);
    let supplied_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToString::to_string);
    let api_key = if use_api_key {
        if let Some(key) = supplied_key {
            Some(Zeroizing::new(key))
        } else {
            let secret_id = active
                .api_key_secret_id
                .as_deref()
                .ok_or_else(|| "尚未配置 AI API Key".to_string())?;
            let credentials = state.credentials.lock().await;
            Some(Zeroizing::new(resolve_credential(&credentials, secret_id)?))
        }
    } else {
        None
    };

    let messages = vec![AiChatMessage {
        role: "user".to_string(),
        content: "hi".to_string(),
    }];
    let claude_format = is_claude_api_format(&api_format);
    let endpoint = ai_chat_endpoint(&base_url, &api_format)?;
    let mut builder = state.ai_http.post(endpoint);
    builder = apply_ai_provider_auth(builder, &api_format, api_key.as_ref().map(|value| value.as_str()));
    let builder = if claude_format {
        let payload = build_claude_messages_payload(&model, &messages, true, 0)?;
        builder.json(&payload)
    } else {
        let payload = OpenAiChatStreamRequest {
            model: &model,
            messages: &messages,
            stream: true,
            max_tokens: None,
            reasoning_effort: None,
            tools: None,
            tool_choice: None,
        };
        builder.json(&payload)
    };

    let started = Instant::now();
    let response = match tokio::time::timeout(AI_HTTP_REQUEST_TIMEOUT, builder.send()).await {
        Ok(result) => result.map_err(|error| format!("连接 API 失败：{error}"))?,
        Err(_) => return Err("连接 API 超时（120 秒无响应）".to_string()),
    };
    let connect_ms = elapsed_ms(started);
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // 部分网关忽略 stream，直接回 JSON
    if content_type.contains("application/json") && !content_type.contains("event-stream") {
        let body = match tokio::time::timeout(AI_HTTP_REQUEST_TIMEOUT, response.text()).await {
            Ok(result) => result.map_err(|error| format!("测试响应读取失败：{error}"))?,
            Err(_) => return Err("测试响应读取超时".to_string()),
        };
        let total_ms = elapsed_ms(started);
        if !status.is_success() {
            return Err(format!(
                "API 返回 HTTP {}：{}",
                status.as_u16(),
                extract_provider_error(&body)
            ));
        }
        let (content, response_model) = if claude_format {
            let value: Value = serde_json::from_str(&body)
                .map_err(|error| format!("测试响应格式不兼容：{error}"))?;
            let content = extract_claude_text_content(&value)
                .ok_or_else(|| "测试响应中没有可用文本".to_string())?;
            let response_model = value
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or(&model)
                .to_string();
            (content, response_model)
        } else {
            let parsed: OpenAiChatResponse = serde_json::from_str(&body)
                .map_err(|error| format!("测试响应格式不兼容：{error}"))?;
            let content = parsed
                .choices
                .first()
                .and_then(|choice| extract_ai_content(&choice.message.content))
                .ok_or_else(|| "测试响应中没有可用文本".to_string())?;
            (
                content,
                parsed.model.unwrap_or_else(|| model.clone()),
            )
        };
        return Ok(TestAiProviderResponse {
            content,
            model: response_model,
            base_url,
            api_format,
            connect_ms,
            // 非流式无法拆分首字，用总耗时近似
            ttft_ms: total_ms,
            total_ms,
        });
    }

    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_default();
        return Err(format!(
            "API 返回 HTTP {}：{}",
            status.as_u16(),
            extract_provider_error(&body)
        ));
    }

    let mut response = response;
    let mut buffer = Vec::new();
    let mut content = String::new();
    let mut response_model = model.clone();
    let mut ttft_ms: Option<u64> = None;

    'stream: loop {
        let chunk_result = tokio::time::timeout(AI_STREAM_CHUNK_IDLE_TIMEOUT, response.chunk()).await;
        match chunk_result {
            Ok(Ok(Some(bytes))) => buffer.extend_from_slice(&bytes),
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                return Err(format!("测试流式响应读取失败：{error}"));
            }
            Err(_) => {
                return Err("测试流式响应空闲超时（长时间没有新数据）".to_string());
            }
        }
        for event in take_sse_events(&mut buffer) {
            let data = match sse_data(&event) {
                Ok(Some(data)) => data,
                Ok(None) => continue,
                Err(error) => return Err(error),
            };
            if data == "[DONE]" {
                break 'stream;
            }
            if claude_format {
                if is_claude_stop_event(&data) {
                    break 'stream;
                }
                match extract_claude_stream_delta(&data) {
                    Ok(Some(delta)) => {
                        if ttft_ms.is_none() {
                            ttft_ms = Some(elapsed_ms(started));
                        }
                        content.push_str(&delta);
                    }
                    Ok(None) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&data) {
                            if let Some(m) = value
                                .pointer("/message/model")
                                .and_then(|v| v.as_str())
                                .or_else(|| value.get("model").and_then(|v| v.as_str()))
                            {
                                if !m.is_empty() {
                                    response_model = m.to_string();
                                }
                            }
                        }
                    }
                    Err(error) => return Err(error),
                }
            } else {
                let chunk: OpenAiStreamChunk = serde_json::from_str(&data)
                    .map_err(|error| format!("测试流式响应格式不兼容：{error}"))?;
                if let Some(m) = chunk.model.filter(|value| !value.is_empty()) {
                    response_model = m;
                }
                for choice in chunk.choices {
                    if let Some(piece) = choice.delta.content.as_ref().and_then(extract_ai_content) {
                        if !piece.is_empty() {
                            if ttft_ms.is_none() {
                                ttft_ms = Some(elapsed_ms(started));
                            }
                            content.push_str(&piece);
                        }
                    }
                }
            }
        }
    }

    let total_ms = elapsed_ms(started);
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("测试响应中没有可用文本".to_string());
    }
    let ttft_ms = ttft_ms.unwrap_or(total_ms);

    Ok(TestAiProviderResponse {
        content,
        model: response_model,
        base_url,
        api_format,
        connect_ms,
        ttft_ms,
        total_ms,
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn validate_ai_stored_action(action: &AiStoredAction) -> Result<usize, String> {
    let serialized = serde_json::to_string(action)
        .map_err(|error| format!("AI 动作记录序列化失败：{error}"))?;
    let chars = serialized.chars().count();
    if chars > 256_000 {
        return Err("单个 AI 动作记录不能超过 256000 个字符".to_string());
    }

    match action {
        AiStoredAction::Edit {
            id,
            summary,
            target_source,
            target_label,
            status,
            edits,
            terminal_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || target_source.trim().is_empty()
                || target_source.chars().count() > 1_024
                || target_label.chars().count() > 260
                || !matches!(
                    status.as_str(),
                    "proposed"
                        | "reading"
                        | "ready"
                        | "applying"
                        | "applied"
                        | "rejected"
                        | "stale"
                        | "error"
                )
                || edits.is_empty()
                || edits.len() > 20
                || edits.iter().any(|edit| {
                    edit.search.is_empty()
                        || edit.search.chars().count() > 100_000
                        || edit.replace.chars().count() > 100_000
                })
                || terminal_id
                    .as_ref()
                    .is_some_and(|terminal_id| terminal_id.len() > 100)
                || created_at.len() > 64
            {
                return Err("AI 文件修改动作记录无效".to_string());
            }
        }
        AiStoredAction::Terminal {
            id,
            summary,
            context_source,
            context_label,
            command,
            timeout_ms,
            status,
            terminal_id,
            tool_call_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || context_source.trim().is_empty()
                || context_source.chars().count() > 1_024
                || context_label.chars().count() > 260
                || command.trim().is_empty()
                || command.chars().count() > 4_000
                || !(3_000..=30_000).contains(timeout_ms)
                || !matches!(
                    status.as_str(),
                    "proposed" | "running" | "completed" | "rejected" | "timeout" | "error"
                )
                || terminal_id.is_empty()
                || terminal_id.len() > 100
                || tool_call_id
                    .as_ref()
                    .is_some_and(|tool_call_id| tool_call_id.len() > 200)
                || created_at.len() > 64
            {
                return Err("AI 终端动作记录无效".to_string());
            }
        }
        AiStoredAction::Mcp {
            id,
            summary,
            server_id,
            tool_name,
            arguments,
            status,
            tool_call_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || server_id.trim().is_empty()
                || server_id.chars().count() > 200
                || tool_name.trim().is_empty()
                || tool_name.chars().count() > 200
                || !arguments.is_object()
                || !matches!(
                    status.as_str(),
                    "proposed" | "running" | "completed" | "rejected" | "error"
                )
                || tool_call_id
                    .as_ref()
                    .is_some_and(|tool_call_id| tool_call_id.len() > 200)
                || created_at.len() > 64
            {
                return Err("AI MCP 动作记录无效".to_string());
            }
        }
    }
    Ok(chars)
}

fn validate_ai_conversation(conversation: &AiConversation) -> Result<(), String> {
    Uuid::parse_str(&conversation.id).map_err(|_| "AI 会话 ID 无效".to_string())?;
    let title = conversation.title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("AI 会话标题必须为 1 到 120 个字符".to_string());
    }
    if !matches!(conversation.mode.as_str(), "ask" | "agent") {
        return Err("AI 会话模式无效".to_string());
    }
    if conversation.messages.len() > 500 {
        return Err("单个 AI 会话最多保存 500 条消息".to_string());
    }
    let mut total_chars = 0usize;
    for message in &conversation.messages {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err("AI 会话消息角色无效".to_string());
        }
        if !matches!(message.status.as_str(), "complete" | "cancelled" | "error") {
            return Err("AI 会话消息状态无效".to_string());
        }
        if message.id.is_empty() || message.id.len() > 100 {
            return Err("AI 会话消息 ID 无效".to_string());
        }
        if message.contexts.len() > 20
            || message.contexts.iter().any(|context| {
                !matches!(context.kind.as_str(), "terminal" | "selection" | "file")
                    || context.label.chars().count() > 260
                    || context
                        .source
                        .as_ref()
                        .is_some_and(|source| source.chars().count() > 1_024)
            })
        {
            return Err("AI 会话上下文引用过多或无效".to_string());
        }
        if message.actions.len() > 20 {
            return Err("单条 AI 会话消息最多保存 20 个动作".to_string());
        }
        let action_chars = message.actions.iter().try_fold(0usize, |total, action| {
            validate_ai_stored_action(action).map(|chars| total.saturating_add(chars))
        })?;
        if action_chars > 512_000 {
            return Err("单条 AI 会话消息的动作记录不能超过 512000 个字符".to_string());
        }
        let chars = message.content.chars().count();
        if chars > 64_000 {
            return Err("单条 AI 会话消息不能超过 64000 个字符".to_string());
        }
        total_chars = total_chars
            .saturating_add(chars)
            .saturating_add(action_chars);
    }
    if total_chars > 2_000_000 {
        return Err("单个 AI 会话内容不能超过 2000000 个字符".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn list_ai_conversations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiConversation>, String> {
    if let Some(error) = state.ai_conversation_error.lock().await.clone() {
        return Err(error);
    }
    Ok(state.ai_conversations.lock().await.conversations.clone())
}

#[tauri::command]
async fn save_ai_conversation(
    conversation: AiConversation,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiConversation>, String> {
    if let Some(error) = state.ai_conversation_error.lock().await.clone() {
        return Err(error);
    }
    validate_ai_conversation(&conversation)?;
    let mut store = state.ai_conversations.lock().await;
    if let Some(existing) = store
        .conversations
        .iter_mut()
        .find(|item| item.id == conversation.id)
    {
        *existing = conversation;
    } else {
        if store.conversations.len() >= 100 {
            return Err("最多保存 100 个 AI 会话，请先删除旧会话".to_string());
        }
        store.conversations.insert(0, conversation);
    }
    save_ai_conversations(&store)?;
    Ok(store.conversations.clone())
}

#[tauri::command]
async fn delete_ai_conversation(
    conversation_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiConversation>, String> {
    if let Some(error) = state.ai_conversation_error.lock().await.clone() {
        return Err(error);
    }
    Uuid::parse_str(&conversation_id).map_err(|_| "AI 会话 ID 无效".to_string())?;
    let mut store = state.ai_conversations.lock().await;
    store.conversations.retain(|item| item.id != conversation_id);
    save_ai_conversations(&store)?;
    Ok(store.conversations.clone())
}

fn emit_ai_stream_event(
    app: &AppHandle,
    request_id: &str,
    kind: &str,
    delta: Option<String>,
    model: Option<String>,
    message: Option<String>,
) {
    emit_ai_stream_event_with_tools(app, request_id, kind, delta, model, message, None);
}

fn emit_ai_stream_event_with_tools(
    app: &AppHandle,
    request_id: &str,
    kind: &str,
    delta: Option<String>,
    model: Option<String>,
    message: Option<String>,
    tool_calls: Option<Vec<AiToolCall>>,
) {
    let _ = app.emit(
        AI_CHAT_STREAM_EVENT,
        AiChatStreamEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            delta,
            model,
            message,
            tool_calls,
        },
    );
}

async fn register_ai_generation(
    state: &AppState,
    request_id: &str,
) -> Result<Option<AiGenerationEntry>, String> {
    Uuid::parse_str(request_id).map_err(|_| "AI 请求 ID 无效".to_string())?;
    let mut generations = state.ai_generations.lock().await;
    if let Some(existing) = generations.get(request_id) {
        if existing.signal.load(Ordering::SeqCst) {
            generations.remove(request_id);
            return Ok(None);
        }
        return Err("同一 AI 请求正在处理中".to_string());
    }
    let entry = AiGenerationEntry {
        signal: Arc::new(AtomicBool::new(false)),
        notification: Arc::new(Notify::new()),
    };
    generations.insert(
        request_id.to_string(),
        AiGenerationEntry {
            signal: Arc::clone(&entry.signal),
            notification: Arc::clone(&entry.notification),
        },
    );
    Ok(Some(entry))
}

async fn finish_ai_generation(state: &AppState, request_id: &str, signal: &Arc<AtomicBool>) {
    let mut generations = state.ai_generations.lock().await;
    if generations
        .get(request_id)
        .is_some_and(|entry| Arc::ptr_eq(&entry.signal, signal))
    {
        generations.remove(request_id);
    }
}

#[tauri::command]
async fn stop_ai_chat(
    request_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    Uuid::parse_str(&request_id).map_err(|_| "AI 请求 ID 无效".to_string())?;
    let mut generations = state.ai_generations.lock().await;
    let entry = generations
        .entry(request_id)
        .or_insert_with(|| AiGenerationEntry {
            signal: Arc::new(AtomicBool::new(true)),
            notification: Arc::new(Notify::new()),
        });
    entry.signal.store(true, Ordering::SeqCst);
    entry.notification.notify_waiters();
    Ok(())
}

#[tauri::command]
async fn ai_chat_stream(
    request: AiChatStreamRequest,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    validate_ai_messages(&request.messages)?;
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let config = state.ai_config.lock().await.clone();
    let account = find_ai_account(&config, None)?.clone();
    let endpoint = ai_chat_endpoint(&account.base_url, &account.api_format)?;
    let api_key = if account.use_api_key {
        let secret_id = account
            .api_key_secret_id
            .as_deref()
            .ok_or_else(|| "尚未配置 AI API Key".to_string())?;
        let credentials = state.credentials.lock().await;
        Some(Zeroizing::new(resolve_credential(&credentials, secret_id)?))
    } else {
        None
    };
    let Some(generation) = register_ai_generation(&state, &request.request_id).await? else {
        emit_ai_stream_event(&app, &request.request_id, "cancelled", None, None, None);
        return Ok(());
    };
    let agent_mode = request
        .mode
        .as_deref()
        .map(str::trim)
        .is_some_and(|mode| mode.eq_ignore_ascii_case("agent"));
    let claude_format = is_claude_api_format(&account.api_format);
    if claude_format && agent_mode {
        emit_ai_stream_event(
            &app,
            &request.request_id,
            "error",
            None,
            None,
            Some("Claude 接口格式暂不支持 Agent 工具调用，请切换到 OpenAI 格式或使用 Ask 模式".to_string()),
        );
        finish_ai_generation(&state, &request.request_id, &generation.signal).await;
        return Ok(());
    }
    let agent_tools = if agent_mode {
        Some(agent_openai_tools())
    } else {
        None
    };
    let mut builder = state.ai_http.post(endpoint);
    builder = apply_ai_provider_auth(builder, &account.api_format, api_key.as_ref().map(|value| value.as_str()));
    let builder = if claude_format {
        let payload =
            match build_claude_messages_payload(&account.model, &request.messages, true, account.max_tokens) {
            Ok(payload) => payload,
            Err(error) => {
                emit_ai_stream_event(&app, &request.request_id, "error", None, None, Some(error));
                finish_ai_generation(&state, &request.request_id, &generation.signal).await;
                return Ok(());
            }
        };
        builder.json(&payload)
    } else {
        let payload = OpenAiChatStreamRequest {
            model: &account.model,
            messages: &request.messages,
            stream: true,
            max_tokens: ai_request_max_tokens(account.max_tokens),
            reasoning_effort: ai_request_reasoning_effort(&config.reasoning_effort),
            tools: agent_tools.as_deref(),
            tool_choice: agent_mode.then_some("auto"),
        };
        builder.json(&payload)
    };
    emit_ai_stream_event(
        &app,
        &request.request_id,
        "started",
        None,
        Some(account.model.clone()),
        None,
    );
    let send_result = tokio::select! {
        result = tokio::time::timeout(AI_HTTP_REQUEST_TIMEOUT, builder.send()) => Some(
            result
                .map_err(|_| "AI 供应商请求超时（120 秒无响应）".to_string())
                .and_then(|attempt| attempt.map_err(|error| format!("AI 供应商请求失败：{error}"))),
        ),
        _ = generation.notification.notified() => None,
    };
    let Some(send_result) = send_result else {
        emit_ai_stream_event(&app, &request.request_id, "cancelled", None, None, None);
        finish_ai_generation(&state, &request.request_id, &generation.signal).await;
        return Ok(());
    };
    let mut response = match send_result {
        Ok(response) => response,
        Err(error) => {
            emit_ai_stream_event(
                &app,
                &request.request_id,
                "error",
                None,
                None,
                Some(error),
            );
            finish_ai_generation(&state, &request.request_id, &generation.signal).await;
            return Ok(());
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = tokio::time::timeout(AI_HTTP_REQUEST_TIMEOUT, response.text())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        emit_ai_stream_event(
            &app,
            &request.request_id,
            "error",
            None,
            None,
            Some(format!(
                "AI 供应商返回 HTTP {}：{}",
                status.as_u16(),
                extract_provider_error(&body)
            )),
        );
        finish_ai_generation(&state, &request.request_id, &generation.signal).await;
        return Ok(());
    }

    let mut buffer = Vec::new();
    let mut response_model = account.model;
    let mut completed = false;
    let mut cancelled = false;
    let mut stream_error = None;
    let mut tool_call_builders: HashMap<usize, StreamToolCallBuilder> = HashMap::new();
    'stream: loop {
        let chunk = tokio::select! {
            result = tokio::time::timeout(AI_STREAM_CHUNK_IDLE_TIMEOUT, response.chunk()) => Some(match result {
                Ok(inner) => inner.map_err(|error| format!("AI 流式响应读取失败：{error}")),
                Err(_) => Err(format!(
                    "AI 流式响应空闲超时（{} 秒内没有新数据）",
                    AI_STREAM_CHUNK_IDLE_TIMEOUT.as_secs()
                )),
            }),
            _ = generation.notification.notified() => None,
        };
        let Some(chunk) = chunk else {
            cancelled = true;
            break;
        };
        match chunk {
            Ok(Some(bytes)) => buffer.extend_from_slice(&bytes),
            Ok(None) => {
                if !completed {
                    let tool_calls = finalize_stream_tool_calls(std::mem::take(&mut tool_call_builders));
                    emit_ai_stream_event_with_tools(
                        &app,
                        &request.request_id,
                        "completed",
                        None,
                        Some(response_model.clone()),
                        None,
                        (!tool_calls.is_empty()).then_some(tool_calls),
                    );
                }
                break;
            }
            Err(error) => {
                emit_ai_stream_event(
                    &app,
                    &request.request_id,
                    "error",
                    None,
                    None,
                    Some(error),
                );
                break;
            }
        }
        for event in take_sse_events(&mut buffer) {
            let data = match sse_data(&event) {
                Ok(Some(data)) => data,
                Ok(None) => continue,
                Err(error) => {
                    stream_error = Some(error);
                    break 'stream;
                }
            };
            if data == "[DONE]" {
                if !completed {
                    let tool_calls = finalize_stream_tool_calls(std::mem::take(&mut tool_call_builders));
                    emit_ai_stream_event_with_tools(
                        &app,
                        &request.request_id,
                        "completed",
                        None,
                        Some(response_model.clone()),
                        None,
                        (!tool_calls.is_empty()).then_some(tool_calls),
                    );
                    completed = true;
                }
                break;
            }
            if claude_format {
                if is_claude_stop_event(&data) {
                    if !completed {
                        emit_ai_stream_event_with_tools(
                            &app,
                            &request.request_id,
                            "completed",
                            None,
                            Some(response_model.clone()),
                            None,
                            None,
                        );
                        completed = true;
                    }
                    break;
                }
                match extract_claude_stream_delta(&data) {
                    Ok(Some(content)) => {
                        emit_ai_stream_event(
                            &app,
                            &request.request_id,
                            "delta",
                            Some(content),
                            None,
                            None,
                        );
                    }
                    Ok(None) => {}
                    Err(error) => {
                        stream_error = Some(error);
                        break 'stream;
                    }
                }
                continue;
            }
            let chunk: OpenAiStreamChunk = match serde_json::from_str(&data) {
                Ok(chunk) => chunk,
                Err(error) => {
                    stream_error = Some(format!("AI 流式响应格式不兼容：{error}"));
                    break 'stream;
                }
            };
            if let Some(model) = chunk.model {
                response_model = model;
            }
            for choice in chunk.choices {
                if let Some(content) = choice.delta.content.as_ref().and_then(extract_ai_content) {
                    emit_ai_stream_event(
                        &app,
                        &request.request_id,
                        "delta",
                        Some(content),
                        None,
                        None,
                    );
                }
                if let Some(tool_deltas) = choice.delta.tool_calls {
                    for tool_delta in tool_deltas {
                        apply_stream_tool_call_delta(&mut tool_call_builders, tool_delta);
                    }
                }
                if choice.finish_reason.is_some() && !completed {
                    let tool_calls = finalize_stream_tool_calls(std::mem::take(&mut tool_call_builders));
                    emit_ai_stream_event_with_tools(
                        &app,
                        &request.request_id,
                        "completed",
                        None,
                        Some(response_model.clone()),
                        None,
                        (!tool_calls.is_empty()).then_some(tool_calls),
                    );
                    completed = true;
                }
            }
        }
        if generation.signal.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if completed {
            break;
        }
    }
    if let Some(error) = stream_error {
        emit_ai_stream_event(
            &app,
            &request.request_id,
            "error",
            None,
            None,
            Some(error),
        );
    } else if cancelled {
        emit_ai_stream_event(&app, &request.request_id, "cancelled", None, None, None);
    }
    finish_ai_generation(&state, &request.request_id, &generation.signal).await;
    Ok(())
}

#[tauri::command]
async fn credential_status(
    state: State<'_, Arc<AppState>>,
) -> Result<CredentialStatus, String> {
    let credentials = state.credentials.lock().await;
    Ok(credential_status_snapshot(&credentials))
}

#[tauri::command]
async fn unlock_credentials(
    master_password: String,
    state: State<'_, Arc<AppState>>,
) -> Result<CredentialStatus, String> {
    let session_store_available = state.session_store_error.lock().await.is_none();
    let mut sessions = if session_store_available {
        Some(state.sessions.lock().await)
    } else {
        None
    };
    let mut credentials = state.credentials.lock().await;
    ensure_vault_available(&credentials)?;
    if credentials.vault.mode != ProtectionMode::MasterPassword {
        return Err("当前凭据仓库未启用 Master Password".to_string());
    }
    let verifier = credentials
        .vault
        .verifier
        .as_ref()
        .ok_or_else(|| "Master Password 校验数据缺失".to_string())?;
    let value = unprotect_secret(
        verifier,
        Some(&master_password),
        CREDENTIAL_VERIFIER_CONTEXT,
    )
    .map_err(|error| match error {
        SecretError::AuthenticationFailed => "Master Password 不正确".to_string(),
        _ => format!("Master Password 校验失败：{error}"),
    })?;
    if value != CREDENTIAL_VERIFIER_VALUE {
        return Err("Master Password 不正确".to_string());
    }
    credentials.master_password = Some(master_password);

    if let Some(sessions) = sessions.as_mut() {
        let mut migrated_sessions = sessions.all().to_vec();
        if migrate_legacy_credentials(&mut migrated_sessions, &mut credentials)? {
            save_credential_vault(&credentials.vault)?;
            save_persistent_sessions(&migrated_sessions)?;
            **sessions = SessionCatalog::new(migrated_sessions);
        }
    }

    Ok(credential_status_snapshot(&credentials))
}

#[tauri::command]
async fn lock_credentials(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.credentials.lock().await.master_password = None;
    Ok(())
}

#[tauri::command]
async fn set_credential_protection(
    request: CredentialProtectionRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<CredentialStatus, String> {
    if request.mode == ProtectionMode::MasterPassword
        && request.master_password.as_deref().unwrap_or_default().len() < 8
    {
        return Err("Master Password 至少需要 8 个字符".to_string());
    }

    let mut credentials = state.credentials.lock().await;
    let current_password = vault_master_password(&credentials)?.map(ToString::to_string);
    let plaintext_entries = credentials
        .vault
        .entries
        .iter()
        .map(|(id, protected)| {
            unprotect_secret(protected, current_password.as_deref(), &credential_context(id))
                .map(|plaintext| (id.clone(), plaintext))
                .map_err(|error| format!("凭据迁移解密失败：{error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let next_password = match request.mode {
        ProtectionMode::Dpapi => None,
        ProtectionMode::MasterPassword => request.master_password,
    };
    let mut next_vault = CredentialVault {
        version: CREDENTIAL_VAULT_VERSION,
        mode: request.mode,
        verifier: None,
        entries: HashMap::new(),
    };
    for (id, plaintext) in plaintext_entries {
        let protected = protect_secret(
            &plaintext,
            request.mode,
            next_password.as_deref(),
            &credential_context(&id),
        )
        .map_err(|error| format!("凭据迁移加密失败：{error}"))?;
        next_vault.entries.insert(id, protected);
    }
    if request.mode == ProtectionMode::MasterPassword {
        next_vault.verifier = Some(
            protect_secret(
                CREDENTIAL_VERIFIER_VALUE,
                ProtectionMode::MasterPassword,
                next_password.as_deref(),
                CREDENTIAL_VERIFIER_CONTEXT,
            )
            .map_err(|error| format!("Master Password 校验数据创建失败：{error}"))?,
        );
    }

    save_credential_vault(&next_vault)?;
    credentials.vault = next_vault;
    credentials.master_password = next_password;
    Ok(credential_status_snapshot(&credentials))
}

#[tauri::command]
async fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<Session>, String> {
    ensure_session_store_available(&state).await?;
    let sessions = state.sessions.lock().await;
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn save_session(
    request: SaveSessionRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
    ensure_session_store_available(&state).await?;
    let mut sessions = state.sessions.lock().await;
    let existing = sessions
        .all()
        .iter()
        .find(|item| item.id == request.session.id)
        .cloned();
    let mut credentials = state.credentials.lock().await;
    let session = prepare_session_for_save(request, existing.as_ref(), &mut credentials)?;
    let obsolete_credentials = existing
        .as_ref()
        .map(|previous| {
            let retained = session_credential_ids(&session);
            session_credential_ids(previous)
                .into_iter()
                .filter(|old_id| !retained.contains(old_id))
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    sessions
        .upsert(session)
        .map_err(|error| error.to_string())?;

    // Commit new credentials before their references. Old credentials remain until
    // the session file succeeds, so an interrupted cross-file update stays usable.
    save_credential_vault(&credentials.vault)?;
    save_persistent_sessions(sessions.all())?;
    if !obsolete_credentials.is_empty() {
        for old_id in obsolete_credentials {
            credentials.vault.entries.remove(&old_id);
        }
        if let Err(error) = save_credential_vault(&credentials.vault) {
            eprintln!("[Credential] obsolete credential cleanup deferred: {error}");
        }
    }
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn delete_session(
    session_id: Uuid,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
    ensure_session_store_available(&state).await?;
    let mut sessions = state.sessions.lock().await;
    let removed = sessions
        .all()
        .iter()
        .find(|session| session.id == session_id)
        .cloned()
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let credential_ids = session_credential_ids(&removed);
    let mut credentials = state.credentials.lock().await;
    if !credential_ids.is_empty() {
        ensure_vault_available(&credentials)?;
    }
    sessions
        .remove(session_id)
        .map_err(|error| error.to_string())?;
    save_persistent_sessions(sessions.all())?;
    if !credential_ids.is_empty() {
        remove_session_credentials(&mut credentials.vault, &removed);
        if let Err(error) = save_credential_vault(&credentials.vault) {
            eprintln!("[Credential] deleted session credential cleanup deferred: {error}");
        }
    }
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn reorder_sessions(
    ordered_ids: Vec<Uuid>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
    ensure_session_store_available(&state).await?;
    let mut sessions = state.sessions.lock().await;
    sessions
        .reorder(&ordered_ids)
        .map_err(|error| error.to_string())?;
    save_persistent_sessions(sessions.all())?;
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn connect_session(
    session_id: Uuid,
    terminal_id: Uuid,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<TerminalEvent, String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .all()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };
    let session = {
        let credentials = state.credentials.lock().await;
        resolved_session(&session, &credentials)?
    };

    let terminal_id_str = terminal_id.to_string();

    // Lock released here — connect_russh_session may take up to 15s.
    let handle = match connect_russh_session(&app, &terminal_id_str, &session).await {
        Ok(handle) => handle,
        Err(error) => {
            emit_remote_log(&app, &terminal_id_str, format!("FAILED {error}"));
            emit_terminal_status(
                &app,
                terminal_id_str,
                TerminalTransport::Remote,
                TerminalLifecycleState::Failed,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    drop(session);
    let remote_session = match spawn_russh_terminal(
        app.clone(),
        terminal_id_str.clone(),
        session_id,
        handle,
    )
    .await
    {
        Ok(remote_session) => remote_session,
        Err(error) => {
            emit_remote_log(&app, &terminal_id_str, format!("FAILED {error}"));
            emit_terminal_status(
                &app,
                terminal_id_str,
                TerminalTransport::Remote,
                TerminalLifecycleState::Failed,
                Some(error.clone()),
            );
            return Err(error);
        }
    };

    let closed = Arc::clone(&remote_session.closed);
    let close_notification = Arc::clone(&remote_session.close_notification);
    let cleanup_state = Arc::clone(state.inner());
    {
        let mut terminals = state.remote_terminals.lock().await;
        // 同一 terminal_id 重连（含 React StrictMode 双触发）时主动关闭旧会话，
        // 防止旧 SSH 连接与写入循环被覆盖后悬挂泄漏（对齐 rdp_connect 的处理）。
        if let Some(prev) = terminals.insert(terminal_id, remote_session) {
            prev.closed.store(true, Ordering::SeqCst);
            prev.close_notification.notify_one();
        }
    }
    tokio::spawn(async move {
        if !closed.load(Ordering::SeqCst) {
            close_notification.notified().await;
        }
        // 只认领自己登记的表项：旧会话被同 id 重连覆盖时，其清理任务可能晚于
        // 新会话插入才被唤醒，绝不能把新会话从表中删掉。
        let owned_slot = {
            let mut terminals = cleanup_state.remote_terminals.lock().await;
            claim_terminal_cleanup(&mut terminals, terminal_id, &closed, |session| {
                &session.closed
            })
        };
        if owned_slot {
            invalidate_transfer_handle(&cleanup_state, terminal_id).await;
        }
    });

    Ok(TerminalEvent {
        session_id: terminal_id,
        kind: TerminalEventKind::Connected,
        payload: String::new(),
    })
}

#[tauri::command]
async fn disconnect_session(
    terminal_id: Uuid,
    state: State<'_, Arc<AppState>>,
) -> Result<TerminalEvent, String> {
    let session = {
        let mut terminals = state.remote_terminals.lock().await;
        terminals.remove(&terminal_id)
    };
    if let Some(session) = session {
        session.closed.store(true, Ordering::SeqCst);
        let _ = session.control.send(RemoteTerminalCommand::Close).await;
    }
    invalidate_transfer_handle(&state, terminal_id).await;

    Ok(TerminalEvent {
        session_id: terminal_id,
        kind: TerminalEventKind::Disconnected,
        payload: String::new(),
    })
}

#[tauri::command]
async fn rdp_connect(
    app: tauri::AppHandle,
    session_id: Uuid,
    terminal_id: Uuid,
    width: u16,
    height: u16,
    quality: rdp::RdpQuality,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    state: State<'_, Arc<AppState>>,
) -> Result<rdp::RdpConnectResult, String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .all()
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    if session.protocol != panda_session::Protocol::Rdp {
        return Err("该会话不是 RDP 协议".to_string());
    }

    let session = {
        let credentials = state.credentials.lock().await;
        resolved_session(&session, &credentials)?
    };

    let password = match &session.auth {
        AuthType::Password { secret_id } => secret_id.clone(),
        _ => return Err("RDP 当前仅支持密码认证".to_string()),
    };

    let params = rdp::RdpConnectParams::new(
        session.host.clone(),
        session.port,
        session.username.clone(),
        password,
        session.domain.clone(),
        quality,
        width,
        height,
    );

    let closed = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let thread_closed = Arc::clone(&closed);
    let (input_tx, input_rx) = std::sync::mpsc::channel::<rdp::RdpInputEvent>();

    // 先登记会话句柄再建连：握手需数秒，若期间标签被关闭（含 React StrictMode 双触发），
    // rdp_disconnect 能立即拿到 closed 句柄取消，避免服务器上残留无法关闭的孤儿会话。
    // 若同一 terminal_id 已有会话，先置位旧会话的 closed 关掉它，防止句柄被覆盖丢失。
    {
        let mut terminals = state.rdp_terminals.lock().await;
        if let Some(prev) = terminals.insert(
            terminal_id,
            rdp::RdpSession {
                closed: Arc::clone(&closed),
                input_tx,
            },
        ) {
            prev.closed.store(true, Ordering::SeqCst);
        }
    }

    thread::spawn(move || {
        rdp::run_session(app, params, channel, thread_closed, ready_tx, input_rx);
    });

    let result = ready_rx
        .await
        .map_err(|_| "RDP 连接线程提前退出".to_string())??;

    Ok(result)
}

#[tauri::command]
async fn rdp_disconnect(
    terminal_id: Uuid,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let session = {
        let mut terminals = state.rdp_terminals.lock().await;
        terminals.remove(&terminal_id)
    };
    if let Some(session) = session {
        session.closed.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn rdp_input(
    terminal_id: Uuid,
    event: rdp::RdpInputEvent,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let input_tx = {
        let terminals = state.rdp_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| session.input_tx.clone())
            .ok_or_else(|| format!("RDP 会话未连接: {terminal_id}"))?
    };
    input_tx
        .send(event)
        .map_err(|_| "RDP 会话线程已退出".to_string())
}

#[tauri::command]
async fn rdp_input_batch(
    terminal_id: Uuid,
    events: Vec<rdp::RdpInputEvent>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let input_tx = {
        let terminals = state.rdp_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| session.input_tx.clone())
            .ok_or_else(|| format!("RDP 会话未连接: {terminal_id}"))?
    };
    for event in events {
        input_tx
            .send(event)
            .map_err(|_| "RDP 会话线程已退出".to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn terminal_write(
    request: TerminalWriteRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<TerminalEvent, String> {
    let control = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&request.terminal_id)
            .map(|session| session.control.clone())
            .ok_or_else(|| format!("terminal is not connected: {}", request.terminal_id))?
    };

    control
        .send(RemoteTerminalCommand::Write(request.data))
        .await
        .map_err(|error| format!("terminal write failed: {error}"))?;

    Ok(TerminalEvent {
        session_id: request.terminal_id,
        kind: TerminalEventKind::Output,
        payload: String::new(),
    })
}

#[tauri::command]
async fn terminal_resize(
    request: TerminalResizeRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let control = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&request.terminal_id)
            .map(|session| session.control.clone())
            .ok_or_else(|| format!("terminal is not connected: {}", request.terminal_id))?
    };

    control
        .send(RemoteTerminalCommand::Resize {
            cols: request.cols.max(1),
            rows: request.rows.max(1),
        })
        .await
        .map_err(|error| format!("terminal resize failed: {error}"))?;

    Ok(())
}

/// Apply Windows dark mode DWM attributes to a dynamically-created window.
/// Called from the frontend when the connection-panel window is created.
#[tauri::command]
fn apply_window_dark_mode(window_label: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;

        if let Some(window) = app.get_webview_window(&window_label) {
            let hwnd = window.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?.0;
            let dark_mode: i32 = 1;
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    &dark_mode as *const _ as *const _,
                    4,
                );
            }
        }
    }
    let _ = window_label; // suppress unused warning on non-Windows
    Ok(())
}

fn main() {
    let (sessions, credentials, session_store_error) = load_secure_state();
    let (ai_config, ai_config_error) = match load_ai_config() {
        Ok(config) => (config, None),
        Err(error) => (AiProviderConfigStore::default(), Some(error)),
    };
    let (ai_conversations, ai_conversation_error) = match load_ai_conversations() {
        Ok(store) => (store, None),
        Err(error) => (AiConversationStore::default(), Some(error)),
    };
    let (mcp_config, mcp_config_error) = match mcp_config_file_path().and_then(|path| mcp::load_mcp_config(&path)) {
        Ok(store) => (store, None),
        Err(error) => (mcp::McpConfigStore::default(), Some(error)),
    };
    let mcp_runtime = Arc::new(mcp::McpRuntime::default());
    let ai_http = Client::builder()
        .redirect(Policy::none())
        // 不设 client 级总超时：它对流式响应同样生效，会掐断长回答。
        // 非流式请求用请求级 .timeout()，流式读循环用块间空闲超时。
        .build()
        .expect("failed to initialize AI HTTP client");
    let state = Arc::new(AppState {
        sessions: Mutex::new(SessionCatalog::new(sessions)),
        session_store_error: Mutex::new(session_store_error),
        credentials: Mutex::new(credentials),
        ai_config: Mutex::new(ai_config),
        ai_config_error: Mutex::new(ai_config_error),
        ai_conversations: Mutex::new(ai_conversations),
        ai_conversation_error: Mutex::new(ai_conversation_error),
        ai_generations: Mutex::new(HashMap::new()),
        ai_http,
        mcp_config: Mutex::new(mcp_config.clone()),
        mcp_config_error: Mutex::new(mcp_config_error),
        mcp_runtime: Arc::clone(&mcp_runtime),
        local_terminals: Mutex::new(HashMap::new()),
        remote_terminals: Mutex::new(HashMap::new()),
        rdp_terminals: Mutex::new(HashMap::new()),
        transfer_handles: Mutex::new(HashMap::new()),
        transfer_cancellations: Mutex::new(HashMap::new()),
        local_sys_monitor: std::sync::Mutex::new(None),
        local_sys_monitor_init: Mutex::new(()),
    });

    // 后台预连接已启用的 stdio MCP（不阻塞启动）
    {
        let runtime = Arc::clone(&mcp_runtime);
        let store = mcp_config;
        tauri::async_runtime::spawn(async move {
            runtime.sync_enabled_servers(&store).await;
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;

                const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
                const DWMWA_CAPTION_COLOR: u32 = 35;
                const DWMWA_TEXT_COLOR: u32 = 36;

                // Apply dark mode DWM attributes to the main window (has native titlebar)
                if let Some(window) = app.get_webview_window("main") {
                    // 拿不到原生句柄时跳过深色模式应用，避免启动路径 panic
                    let Ok(native_hwnd) = window.hwnd() else { return Ok(()); };
                    let hwnd = native_hwnd.0;
                    let dark_mode: i32 = 1;
                    let bg_color: u32 = 0x0027221e; // #1e2227 BGR
                    let text_color: u32 = 0x00d0c4c2; // #c2c4d0 BGR
                    unsafe {
                        let _ = DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_USE_IMMERSIVE_DARK_MODE,
                            &dark_mode as *const _ as *const _,
                            4,
                        );
                        let _ = DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_CAPTION_COLOR,
                            &bg_color as *const _ as *const _,
                            4,
                        );
                        let _ = DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_TEXT_COLOR,
                            &text_color as *const _ as *const _,
                            4,
                        );
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_fs::list_local_directory,
            local_fs::read_local_file_preview,
            local_fs::read_local_file_full,
            local_terminal_profile_command,
            local_terminal_start,
            local_terminal_input,
            local_terminal_resize,
            local_terminal_stop,
            local_terminal_write,
            list_sessions,
            save_session,
            delete_session,
            reorder_sessions,
            credential_status,
            unlock_credentials,
            lock_credentials,
            set_credential_protection,
            get_ai_provider_config,
            save_ai_provider_config,
            add_ai_provider_account,
            delete_ai_provider_account,
            set_active_ai_provider_account,
            sync_ai_provider_models,
            test_ai_provider,
            get_mcp_config,
            save_mcp_config,
            reconnect_mcp_server,
            list_mcp_tools,
            call_mcp_tool,
            list_mcp_import_candidates,
            import_mcp_servers_from_path,
            export_mcp_servers_cursor_json,
            ai_chat,
            ai_chat_stream,
            stop_ai_chat,
            list_ai_conversations,
            save_ai_conversation,
            delete_ai_conversation,
            run_ai_terminal_command,
            connect_session,
            disconnect_session,
            rdp_connect,
            rdp_disconnect,
            rdp_input,
            rdp_input_batch,
            terminal_write,
            terminal_resize,
            list_remote_directory,
            read_remote_file_preview,
            read_remote_file_full,
            write_local_file,
            write_local_file_checked,
            write_remote_file,
            write_remote_file_checked,
            upload_file,
            upload_local_file,
            cancel_transfer,
            upload_directory,
            read_file_as_data_url,
            download_remote_file,
            extract_archive,
            create_archive,
            delete_path,
            create_file,
            create_directory,
            copy_path,
            move_path,
            get_local_ipv4,
            get_system_monitor,
            get_process_list,
            get_upload_concurrency,
            apply_window_dark_mode,
            about::fetch_latest_github_version,
            about::open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PandaTerm");
}

#[cfg(test)]
mod tests {
    use super::*;
    use ai_config::ai_chat_completions_url;

    #[test]
    fn terminal_lifecycle_event_serializes_as_frontend_contract() {
        let event = TerminalStatusEvent {
            terminal_id: "terminal-1".to_string(),
            transport: TerminalTransport::Remote,
            state: TerminalLifecycleState::Failed,
            reason: Some("channel closed".to_string()),
        };
        let value = serde_json::to_value(event).expect("serialize terminal status");
        assert_eq!(value["terminal_id"], "terminal-1");
        assert_eq!(value["transport"], "remote");
        assert_eq!(value["state"], "failed");
        assert_eq!(value["reason"], "channel closed");
    }

    #[test]
    fn claude_stop_detected_by_type_field_not_substring() {
        // 真正的 message_stop 事件
        assert!(is_claude_stop_event(r#"{"type":"message_stop"}"#));

        // 正文里出现字面量 message_stop 时绝不能误判（回归：旧实现用子串匹配会截断回答）
        let delta_with_literal = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the stream ends at \"message_stop\" event"}}"#;
        assert!(!is_claude_stop_event(delta_with_literal));

        let message_start = r#"{"type":"message_start","message":{"model":"claude-x"}}"#;
        assert!(!is_claude_stop_event(message_start));

        // 非 JSON 行（个别网关的日志/心跳）不终止流
        assert!(!is_claude_stop_event("event: ping data message_stop"));
    }

    #[test]
    fn local_terminal_exit_maps_reader_result_to_lifecycle_state() {
        assert_eq!(
            local_terminal_exit_state(None),
            TerminalLifecycleState::Disconnected
        );
        assert_eq!(
            local_terminal_exit_state(Some("read failed")),
            TerminalLifecycleState::Failed
        );
    }

    #[test]
    fn terminal_cleanup_claim_is_idempotent() {
        let terminal_id = Uuid::new_v4();
        let mut terminals = HashMap::from([(terminal_id, "session")]);

        assert_eq!(
            take_terminal_session(&mut terminals, terminal_id),
            Some("session")
        );
        assert_eq!(take_terminal_session(&mut terminals, terminal_id), None);
    }

    #[test]
    fn competing_terminal_cleanup_paths_have_one_owner() {
        let terminal_id = Uuid::new_v4();
        let terminals = Arc::new(std::sync::Mutex::new(HashMap::from([(
            terminal_id,
            "session",
        )])));
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let claims = (0..2)
            .map(|_| {
                let terminals = Arc::clone(&terminals);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    let mut terminals = terminals.lock().expect("lock terminal map");
                    take_terminal_session(&mut terminals, terminal_id).is_some()
                })
            })
            .collect::<Vec<_>>();

        let owner_count = claims
            .into_iter()
            .map(|claim| claim.join().expect("join cleanup contender"))
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(owner_count, 1);
    }

    struct CleanupProbe {
        closed: Arc<AtomicBool>,
    }

    #[test]
    fn stale_remote_cleanup_never_removes_reconnected_entry() {
        let terminal_id = Uuid::new_v4();
        let old_closed = Arc::new(AtomicBool::new(false));
        let new_closed = Arc::new(AtomicBool::new(false));
        let mut terminals =
            HashMap::from([(terminal_id, CleanupProbe { closed: Arc::clone(&old_closed) })]);

        // 模拟重连覆盖：同 id 插入新会话（旧会话被主动置为 closed）
        assert!(terminals
            .insert(terminal_id, CleanupProbe { closed: Arc::clone(&new_closed) })
            .is_some());
        old_closed.store(true, Ordering::SeqCst);

        // 旧清理任务此时才被唤醒：必须拒绝认领，不得删掉新会话
        assert!(!claim_terminal_cleanup(
            &mut terminals,
            terminal_id,
            &old_closed,
            |probe| &probe.closed
        ));
        assert!(terminals.contains_key(&terminal_id));

        // 新会话可被自己的清理任务认领；重复认领是 no-op
        assert!(claim_terminal_cleanup(
            &mut terminals,
            terminal_id,
            &new_closed,
            |probe| &probe.closed
        ));
        assert!(!terminals.contains_key(&terminal_id));
        assert!(!claim_terminal_cleanup(
            &mut terminals,
            terminal_id,
            &new_closed,
            |probe| &probe.closed
        ));
    }

    #[test]
    fn drive_enumeration_includes_both_boundaries() {
        let letters: Vec<char> = local_fs::windows_drive_letters().collect();
        assert_eq!(letters.len(), 26);
        assert_eq!(letters.first(), Some(&'A'));
        assert_eq!(letters.last(), Some(&'Z'));
    }

    #[test]
    fn remote_temp_path_sanitizes_transfer_id() {
        assert_eq!(
            remote_temp_path("/tmp/report.txt", "job/42:unsafe"),
            "/tmp/report.txt.pandaterm-job42unsafe.part"
        );
    }

    #[test]
    fn upload_completion_accepts_marker_without_exit_status() {
        assert!(validate_remote_upload_completion(None, true, b"").is_ok());
        assert!(validate_remote_upload_completion(Some(0), true, b"").is_ok());
        assert!(validate_remote_upload_completion(None, false, b"").is_err());
        let err = validate_remote_upload_completion(Some(1), true, b"cat: Permission denied\n")
            .expect_err("exit 1 must fail");
        assert!(err.contains("退出码: 1"));
        assert!(err.contains("Permission denied"));
    }

    #[test]
    fn download_destination_avoids_overwriting_existing_file() {
        let directory = std::env::temp_dir().join(format!("pandaterm-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        fs::write(directory.join("report.txt"), b"existing").expect("create existing file");

        let destination = write_unique_local_file(&directory, "report.txt", b"new")
            .expect("write unique destination");
        assert_eq!(destination, directory.join("report (1).txt"));
        assert_eq!(fs::read(destination).expect("read downloaded file"), b"new");

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn concurrent_download_writes_reserve_distinct_paths() {
        let directory = Arc::new(
            std::env::temp_dir().join(format!("pandaterm-test-{}", Uuid::new_v4())),
        );
        fs::create_dir_all(directory.as_ref()).expect("create test directory");
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let writers = [b"first".as_slice(), b"second".as_slice()].map(|content| {
            let directory = Arc::clone(&directory);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                write_unique_local_file(directory.as_ref(), "report.txt", content)
                    .expect("write unique download")
            })
        });
        let [first, second] = writers.map(|writer| writer.join().expect("join download writer"));

        assert_ne!(first, second);
        assert_eq!(fs::read(&first).expect("read first download").len(), 5);
        assert_eq!(fs::read(&second).expect("read second download").len(), 6);

        fs::remove_dir_all(directory.as_ref()).expect("remove test directory");
    }

    #[test]
    fn atomic_text_write_replaces_complete_file() {
        let directory = std::env::temp_dir().join(format!("pandaterm-test-{}", Uuid::new_v4()));
        let path = directory.join("credentials.json");

        atomic_write_text(&path, "first").expect("write initial file");
        atomic_write_text(&path, "second").expect("replace file");
        assert_eq!(fs::read_to_string(&path).expect("read replaced file"), "second");
        assert_eq!(
            fs::read_dir(&directory)
                .expect("read test directory")
                .filter_map(Result::ok)
                .count(),
            1
        );

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[tokio::test]
    async fn checked_ai_write_rejects_stale_content() {
        let directory = std::env::temp_dir().join(format!("pandaterm-test-{}", Uuid::new_v4()));
        let path = directory.join("proposal.txt");
        atomic_write_text(&path, "current").expect("write initial file");

        let error = write_local_file_checked(
            path.to_string_lossy().into_owned(),
            "outdated".to_string(),
            "replacement".to_string(),
        )
        .await
        .expect_err("reject stale write");

        assert!(error.starts_with("AI_EDIT_STALE:"));
        assert_eq!(fs::read_to_string(&path).expect("read unchanged file"), "current");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn ai_terminal_output_keeps_bounded_tail() {
        let oversized = vec![b'x'; AI_TERMINAL_OUTPUT_LIMIT + 128];
        let (output, truncated) = bounded_ai_terminal_output(&oversized, b"stderr-tail");
        assert!(truncated);
        assert!(output.contains("输出已截断"));
        assert!(output.ends_with("stderr-tail"));
        assert!(output.len() <= AI_TERMINAL_OUTPUT_LIMIT + 128);
    }

    #[tokio::test]
    async fn ai_local_terminal_command_captures_output() {
        let command = if cfg!(target_os = "windows") {
            "Write-Output 'pandaterm-ai-tool'"
        } else {
            "printf 'pandaterm-ai-tool'"
        };
        let result = run_ai_local_terminal_command(command, Duration::from_secs(5))
            .await
            .expect("run isolated command");
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.contains("pandaterm-ai-tool"));
    }

    #[test]
    fn ai_conversation_mode_defaults_and_validates() {
        let legacy = r#"{
            "id":"00000000-0000-0000-0000-000000000001",
            "title":"legacy",
            "created_at":"2026-01-01T00:00:00Z",
            "updated_at":"2026-01-01T00:00:00Z",
            "messages":[{
                "id":"message-1",
                "role":"assistant",
                "content":"legacy message",
                "contexts":[],
                "created_at":"2026-01-01T00:00:00Z",
                "status":"complete"
            }]
        }"#;
        let mut conversation: AiConversation =
            serde_json::from_str(legacy).expect("deserialize legacy conversation");
        assert_eq!(conversation.mode, "ask");
        assert!(conversation.messages[0].actions.is_empty());
        validate_ai_conversation(&conversation).expect("validate default ask mode");

        conversation.mode = "automatic".to_string();
        assert_eq!(
            validate_ai_conversation(&conversation).expect_err("reject invalid mode"),
            "AI 会话模式无效"
        );
    }

    #[test]
    fn ai_endpoint_accepts_custom_openai_compatible_base_urls() {
        assert_eq!(
            ai_chat_completions_url("https://api.openai.com/v1")
                .expect("build OpenAI endpoint")
                .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            ai_models_url("https://api.openai.com/v1")
                .expect("build models endpoint")
                .as_str(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            ai_chat_completions_url("gateway.example.com/openai/v1/")
                .expect("build custom endpoint")
                .as_str(),
            "https://gateway.example.com/openai/v1/chat/completions"
        );
        assert!(ai_chat_completions_url("file:///tmp/model").is_err());
        assert!(ai_chat_completions_url("https://user:secret@example.com/v1").is_err());
    }

    #[test]
    fn merge_ai_models_keeps_customs_and_overwrites_matches() {
        let existing = vec![
            "custom-a".to_string(),
            "gpt-4o-mini".to_string(),
            "custom-b".to_string(),
        ];
        let synced = vec![
            "gpt-4o-mini".to_string(),
            "gpt-4o".to_string(),
            "o1-mini".to_string(),
        ];
        let merged = merge_ai_models(&existing, &synced).expect("merge models");
        assert_eq!(
            merged,
            vec![
                "custom-a".to_string(),
                "gpt-4o-mini".to_string(),
                "custom-b".to_string(),
                "gpt-4o".to_string(),
                "o1-mini".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_enabled_ai_models_defaults_to_all_and_keeps_selected() {
        let models = vec![
            "gpt-4o-mini".to_string(),
            "gpt-5.6-terra".to_string(),
            "o1-mini".to_string(),
        ];
        // 旧配置：enabled 为空 → 启用全部
        let all = normalize_enabled_ai_models(&models, &[], "gpt-5.6-terra")
            .expect("default enable all");
        assert_eq!(all, models);

        // 仅保留仍存在的已选项，并强制包含当前 model（当前 model 前置）
        let enabled = normalize_enabled_ai_models(
            &models,
            &["o1-mini".to_string(), "gone".to_string()],
            "gpt-5.6-terra",
        )
        .expect("normalize enabled");
        assert_eq!(
            enabled,
            vec!["gpt-5.6-terra".to_string(), "o1-mini".to_string()]
        );
    }

    #[test]
    fn validate_and_serialize_ai_reasoning_effort() {
        assert_eq!(
            validate_ai_reasoning_effort(" Medium ").expect("accept medium"),
            "medium"
        );
        assert!(validate_ai_reasoning_effort("ultra").is_err());
        assert_eq!(ai_request_reasoning_effort("none"), None);
        assert_eq!(ai_request_reasoning_effort("high"), Some("high"));

        let messages = [AiChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        }];
        let with_effort = serde_json::to_value(OpenAiChatRequest {
            model: "o3-mini",
            messages: &messages,
            max_tokens: None,
            reasoning_effort: Some("high"),
        })
        .expect("serialize with effort");
        assert_eq!(
            with_effort.get("reasoning_effort").and_then(Value::as_str),
            Some("high")
        );

        let without_effort = serde_json::to_value(OpenAiChatRequest {
            model: "gpt-4o-mini",
            messages: &messages,
            max_tokens: None,
            reasoning_effort: None,
        })
        .expect("serialize without effort");
        assert!(without_effort.get("reasoning_effort").is_none());
    }

    #[test]
    fn serialize_ai_max_tokens_only_when_configured() {
        assert_eq!(ai_request_max_tokens(0), None);
        assert_eq!(ai_request_max_tokens(4096), Some(4096));
        assert_eq!(validate_ai_max_tokens(0).expect("unlimited"), 0);
        assert!(validate_ai_max_tokens(u32::MAX).is_err());
        assert_eq!(
            validate_ai_context_window(0).expect("zero falls back"),
            DEFAULT_AI_CONTEXT_WINDOW
        );
        assert_eq!(
            validate_ai_context_window(32_000).expect("accept 32k"),
            32_000
        );
        assert!(validate_ai_context_window(10).is_err());
        assert!(validate_ai_context_window(3_000_000).is_err());

        let messages = [AiChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        }];
        let configured = serde_json::to_value(OpenAiChatStreamRequest {
            model: "gpt-4o-mini",
            messages: &messages,
            stream: true,
            max_tokens: ai_request_max_tokens(4096),
            reasoning_effort: None,
            tools: None,
            tool_choice: None,
        })
        .expect("serialize max_tokens");
        assert_eq!(configured.get("max_tokens").and_then(Value::as_u64), Some(4096));

        let unlimited = serde_json::to_value(OpenAiChatStreamRequest {
            model: "gpt-4o-mini",
            messages: &messages,
            stream: true,
            max_tokens: ai_request_max_tokens(0),
            reasoning_effort: None,
            tools: None,
            tool_choice: None,
        })
        .expect("serialize without max_tokens");
        assert!(unlimited.get("max_tokens").is_none());
    }

    #[test]
    fn parse_openai_model_ids_from_list_response() {
        let body = r#"{"object":"list","data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"},"raw-string-model"]}"#;
        let models = parse_openai_model_ids(body).expect("parse models");
        assert_eq!(
            models,
            vec![
                "gpt-4o".to_string(),
                "gpt-4o-mini".to_string(),
                "raw-string-model".to_string(),
            ]
        );
    }

    #[test]
    fn stream_tool_call_deltas_merge_by_index() {
        let mut builders = HashMap::new();
        apply_stream_tool_call_delta(
            &mut builders,
            OpenAiStreamToolCallDelta {
                index: 0,
                id: Some("call_1".to_string()),
                function: Some(OpenAiStreamFunctionDelta {
                    name: Some("run_terminal_command".to_string()),
                    arguments: Some("{\"summary\":".to_string()),
                }),
            },
        );
        apply_stream_tool_call_delta(
            &mut builders,
            OpenAiStreamToolCallDelta {
                index: 0,
                id: None,
                function: Some(OpenAiStreamFunctionDelta {
                    name: None,
                    arguments: Some("\"ls\",\"context_source\":\"terminal:a\",\"command\":\"ls\"}".to_string()),
                }),
            },
        );
        let tools = finalize_stream_tool_calls(builders);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "call_1");
        assert_eq!(tools[0].name, "run_terminal_command");
        assert!(tools[0].arguments.contains("context_source"));
        assert_eq!(agent_openai_tools().len(), 2);
    }

    #[test]
    fn agent_stream_request_serializes_tools_only_when_present() {
        let messages = [AiChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        }];
        let tools = agent_openai_tools();
        let with_tools = serde_json::to_value(OpenAiChatStreamRequest {
            model: "gpt-4o-mini",
            messages: &messages,
            stream: true,
            max_tokens: None,
            reasoning_effort: None,
            tools: Some(tools.as_slice()),
            tool_choice: Some("auto"),
        })
        .expect("serialize tools");
        assert!(with_tools.get("tools").is_some());
        assert_eq!(
            with_tools.get("tool_choice").and_then(Value::as_str),
            Some("auto")
        );

        let without_tools = serde_json::to_value(OpenAiChatStreamRequest {
            model: "gpt-4o-mini",
            messages: &messages,
            stream: true,
            max_tokens: None,
            reasoning_effort: None,
            tools: None,
            tool_choice: None,
        })
        .expect("serialize without tools");
        assert!(without_tools.get("tools").is_none());
        assert!(without_tools.get("tool_choice").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_destination_uses_windows_path_components() {
        let destination = destination_path(
            r"C:\source\report.txt",
            r"D:\downloads",
            None,
            false,
        )
        .expect("resolve Windows destination");
        assert_eq!(destination, r"D:\downloads\report.txt");
    }

    #[test]
    fn host_port_format_brackets_ipv6_without_double_bracketing() {
        assert_eq!(format_host_port("2001:db8::1", 22), "[2001:db8::1]:22");
        assert_eq!(format_host_port("[2001:db8::1]", 3389), "[2001:db8::1]:3389");
        assert_eq!(format_host_port("example.com", 22), "example.com:22");
    }

    #[test]
    fn remote_destination_rejects_multi_segment_names() {
        // 路径穿越（../..）与多段名字都必须拒绝，防止绕过所在目录约束
        for bad in ["../../etc/cron.d/pwn", "a/b", "..", ".", "\0x"] {
            assert!(
                destination_path("/var/www/html/index.html", "/srv", Some(bad.to_string()), true)
                    .is_err(),
                "remote dest_name={bad:?} should be rejected"
            );
        }
        // 合法单段名字仍可用；缺省时取源文件名
        assert_eq!(
            destination_path("/var/www/html/index.html", "/srv/", Some("new.html".into()), true)
                .expect("valid remote rename"),
            "/srv/new.html"
        );
        assert_eq!(
            destination_path("/var/www/html/index.html", "/srv", None, true)
                .expect("default source name"),
            "/srv/index.html"
        );
    }
}
