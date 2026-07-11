#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use encoding_rs::GBK;
use panda_core::{TerminalEvent, TerminalEventKind};
use panda_crypto::{protect_secret, unprotect_secret, ProtectedSecret, ProtectionMode, SecretError};
use panda_session::{AuthType, ReconnectPolicy, Session, SessionCatalog};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use reqwest::{redirect::Policy, Client, Url};
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
    local_terminals: Mutex<HashMap<Uuid, LocalTerminalSession>>,
    remote_terminals: Mutex<HashMap<Uuid, RemoteTerminalSession>>,
    /// Reused SSH handles for file transfer (keyed by interactive terminal id).
    transfer_handles: Mutex<HashMap<Uuid, SharedRemoteHandle>>,
    /// Transfer cancellation state keyed by the frontend transfer id.
    transfer_cancellations: Mutex<HashMap<String, TransferCancellationEntry>>,
    /// Cached sysinfo::System for local CPU usage monitoring.
    /// Keeps CPU time counters alive so that `refresh_cpu_usage()` computes
    /// correct deltas between successive calls instead of starting from scratch.
    local_sys_monitor: std::sync::Mutex<Option<sysinfo::System>>,
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

const CREDENTIAL_VAULT_VERSION: u8 = 1;
const CREDENTIAL_ID_PREFIX: &str = "credential:";
const CREDENTIAL_VERIFIER_CONTEXT: &str = "pandaterm:credential-verifier";
const CREDENTIAL_VERIFIER_VALUE: &str = "pandaterm-master-password-verifier-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CredentialVault {
    version: u8,
    mode: ProtectionMode,
    verifier: Option<ProtectedSecret>,
    entries: HashMap<String, ProtectedSecret>,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self {
            version: CREDENTIAL_VAULT_VERSION,
            mode: ProtectionMode::Dpapi,
            verifier: None,
            entries: HashMap::new(),
        }
    }
}

struct CredentialVaultState {
    vault: CredentialVault,
    master_password: Option<String>,
    load_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CredentialStatus {
    mode: ProtectionMode,
    locked: bool,
    credential_count: usize,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CredentialProtectionRequest {
    mode: ProtectionMode,
    master_password: Option<String>,
}

const AI_CONFIG_VERSION: u8 = 1;
const AI_API_KEY_PREFIX: &str = "credential:ai:openai-compatible:api-key";
const DEFAULT_AI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_AI_MODEL: &str = "gpt-4o-mini";
const MAX_AI_MESSAGES: usize = 100;
const MAX_AI_MESSAGE_CHARS: usize = 32_000;
const MAX_AI_TOTAL_CHARS: usize = 128_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiProviderConfigStore {
    version: u8,
    base_url: String,
    model: String,
    /// 可选模型目录（同步 + 自定义）；同步时不会清空未出现在远端的自定义项
    #[serde(default)]
    models: Vec<String>,
    /// 出现在聊天模型列表中的已选模型（子集）；缺省迁移为全部 models
    #[serde(default)]
    enabled_models: Vec<String>,
    use_api_key: bool,
    api_key_secret_id: Option<String>,
}

impl Default for AiProviderConfigStore {
    fn default() -> Self {
        Self {
            version: AI_CONFIG_VERSION,
            base_url: DEFAULT_AI_BASE_URL.to_string(),
            model: DEFAULT_AI_MODEL.to_string(),
            models: vec![DEFAULT_AI_MODEL.to_string()],
            enabled_models: vec![DEFAULT_AI_MODEL.to_string()],
            use_api_key: true,
            api_key_secret_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct AiProviderConfig {
    base_url: String,
    model: String,
    models: Vec<String>,
    enabled_models: Vec<String>,
    use_api_key: bool,
    api_key_configured: bool,
    /// 本地桌面设置可回填展示；仅来自本机 vault 解密结果
    api_key: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SaveAiProviderConfigRequest {
    base_url: String,
    model: String,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    enabled_models: Option<Vec<String>>,
    use_api_key: bool,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SyncAiModelsRequest {
    /// 可选：用草稿 Base URL 拉列表；缺省用已保存配置
    base_url: Option<String>,
    use_api_key: Option<bool>,
    api_key: Option<String>,
}

const AI_CONVERSATION_VERSION: u8 = 1;
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
    created_at: String,
    status: String,
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
}

#[derive(Debug, Clone, Serialize)]
struct AiChatStreamEvent {
    request_id: String,
    kind: String,
    delta: Option<String>,
    model: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAiChatStreamRequest<'a> {
    model: &'a str,
    messages: &'a [AiChatMessage],
    stream: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalDirectoryEntry {
    name: String,
    path: String,
    entry_type: String,
    size: u64,
    modified_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalDirectoryListing {
    path: String,
    parent: Option<String>,
    entries: Vec<LocalDirectoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalFilePreview {
    path: String,
    name: String,
    size: u64,
    content: String,
    truncated: bool,
}

const LOCAL_FILE_PREVIEW_LIMIT: u64 = 512 * 1024;
const LOCAL_FILE_FULL_LIMIT: u64 = 50 * 1024 * 1024;
const REMOTE_FILE_FULL_LIMIT: u64 = 50 * 1024 * 1024;
const AI_TERMINAL_COMMAND_MAX_LENGTH: usize = 4_000;
const AI_TERMINAL_OUTPUT_LIMIT: usize = 64 * 1024;
const AI_TERMINAL_MIN_TIMEOUT_MS: u64 = 3_000;
const AI_TERMINAL_MAX_TIMEOUT_MS: u64 = 30_000;
const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";

const REMOTE_TERMINAL_READY_MARKER: &str = "__PANDATERM_REMOTE_READY__";

fn emit_remote_log(_app: &AppHandle, terminal_id: &str, message: impl AsRef<str>) {
    eprintln!("[SSH {}] {}", terminal_id, message.as_ref());
}

fn emit_remote_ready(app: &AppHandle, terminal_id: &str) {
    emit_terminal_output(
        app,
        terminal_id.to_string(),
        format!("{REMOTE_TERMINAL_READY_MARKER}\r\n"),
    );
}

fn xshell_sessions_path() -> Option<PathBuf> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| home.join(r"Documents\NetSarang Computer\8\Xshell\Sessions"))
        .filter(|path| path.is_dir())
}

fn parse_ini_value(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    content.lines().find_map(|line| {
        line.strip_prefix(&prefix)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn parse_xshell_session(path: &Path) -> Option<Session> {
    let content = fs::read_to_string(path).ok()?;
    let host = parse_ini_value(&content, "Host")?;
    let protocol = parse_ini_value(&content, "Protocol").unwrap_or_else(|| "SSH".to_string());
    if !protocol.eq_ignore_ascii_case("ssh") {
        return None;
    }

    let name = path.file_stem()?.to_string_lossy().to_string();
    let port = parse_ini_value(&content, "Port")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);
    let username = parse_ini_value(&content, "UserName").unwrap_or_else(|| "root".to_string());

    Some(Session {
        id: Uuid::new_v4(),
        name,
        group: "Xshell".to_string(),
        host,
        port,
        username,
        auth: AuthType::Agent,
        tags: vec!["xshell".to_string(), protocol.to_lowercase()],
        last_connected_at: None,
        reconnect: ReconnectPolicy::default(),
    })
}

fn load_xshell_sessions() -> Vec<Session> {
    let Some(directory) = xshell_sessions_path() else {
        return Vec::new();
    };

    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut sessions = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xsh"))
        })
        .filter_map(|path| parse_xshell_session(&path))
        .collect::<Vec<_>>();

    sessions.sort_by_key(|session| session.name.to_lowercase());
    sessions
}

fn session_store_path() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .ok_or_else(|| "无法定位用户目录".to_string())?;

    Ok(home.join(".pandaterm").join("ssh-connections.json"))
}

fn pandaterm_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join(".pandaterm"))
}

fn known_hosts_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("known_hosts.json"))
}

fn credential_vault_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("credentials.json"))
}

fn ai_config_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("ai-provider.json"))
}

fn ai_conversations_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("ai-conversations.json"))
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
    let store: AiConversationStore = serde_json::from_str(&content)
        .map_err(|error| format!("AI 会话记录已损坏，已拒绝覆盖原文件：{error}"))?;
    if store.version != AI_CONVERSATION_VERSION {
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

fn load_ai_config() -> Result<AiProviderConfigStore, String> {
    let path = ai_config_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AiProviderConfigStore::default());
        }
        Err(error) => return Err(format!("AI 供应商配置读取失败：{error}")),
    };
    let mut config: AiProviderConfigStore = serde_json::from_str(&content)
        .map_err(|error| format!("AI 供应商配置已损坏，已拒绝覆盖原文件：{error}"))?;
    if config.version != AI_CONFIG_VERSION {
        return Err(format!("不支持的 AI 供应商配置版本：{}", config.version));
    }
    validate_ai_base_url(&config.base_url)?;
    config.model = validate_ai_model(&config.model)?;
    config.models = normalize_ai_models(&config.models, &config.model)?;
    config.enabled_models =
        normalize_enabled_ai_models(&config.models, &config.enabled_models, &config.model)?;
    Ok(config)
}

fn save_ai_config(config: &AiProviderConfigStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("AI 供应商配置序列化失败：{error}"))?;
    atomic_write_text(&ai_config_path()?, &content)
        .map_err(|error| format!("AI 供应商配置保存失败：{error}"))
}

fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法定位文件目录：{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("目录创建失败：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pandaterm-data");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("临时文件创建失败：{error}"))?;
        file.write_all(content)
            .map_err(|error| format!("临时文件写入失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("临时文件同步失败：{error}"))?;
        drop(file);
        replace_file(&temporary, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content.as_bytes())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(format!("原子替换失败：{}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| format!("原子替换失败：{error}"))
}

fn credential_context(id: &str) -> String {
    format!("pandaterm:credential:{id}")
}

fn credential_id(session_id: Uuid, kind: &str) -> String {
    format!("{CREDENTIAL_ID_PREFIX}{session_id}:{kind}")
}

fn is_credential_id(value: &str) -> bool {
    value.starts_with(CREDENTIAL_ID_PREFIX)
}

fn load_credential_vault() -> Result<CredentialVault, String> {
    let path = credential_vault_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CredentialVault::default());
        }
        Err(error) => return Err(format!("凭据仓库读取失败：{error}")),
    };
    let vault: CredentialVault = serde_json::from_str(&content)
        .map_err(|error| format!("凭据仓库已损坏，已拒绝覆盖原文件：{error}"))?;
    if vault.version != CREDENTIAL_VAULT_VERSION {
        return Err(format!("不支持的凭据仓库版本：{}", vault.version));
    }
    if vault.mode == ProtectionMode::MasterPassword && vault.verifier.is_none() {
        return Err("凭据仓库已损坏：Master Password 校验数据缺失，已拒绝覆盖原文件".to_string());
    }
    Ok(vault)
}

fn save_credential_vault(vault: &CredentialVault) -> Result<(), String> {
    let path = credential_vault_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("凭据目录创建失败：{error}"))?;
    }
    let content = serde_json::to_string_pretty(vault)
        .map_err(|error| format!("凭据序列化失败：{error}"))?;
    atomic_write_text(&path, &content).map_err(|error| format!("凭据保存失败：{error}"))
}

fn ensure_vault_available(state: &CredentialVaultState) -> Result<(), String> {
    match &state.load_error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

async fn ensure_session_store_available(state: &AppState) -> Result<(), String> {
    match &*state.session_store_error.lock().await {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

fn credential_status_snapshot(state: &CredentialVaultState) -> CredentialStatus {
    CredentialStatus {
        mode: state.vault.mode,
        locked: state.load_error.is_some()
            || (state.vault.mode == ProtectionMode::MasterPassword
                && state.master_password.is_none()),
        credential_count: state.vault.entries.len(),
        error: state.load_error.clone(),
    }
}

fn vault_master_password(state: &CredentialVaultState) -> Result<Option<&str>, String> {
    ensure_vault_available(state)?;
    match state.vault.mode {
        ProtectionMode::Dpapi => Ok(None),
        ProtectionMode::MasterPassword => state
            .master_password
            .as_deref()
            .map(Some)
            .ok_or_else(|| "凭据仓库已锁定，请先输入 Master Password 解锁".to_string()),
    }
}

fn resolve_credential(state: &CredentialVaultState, id: &str) -> Result<String, String> {
    let protected = state
        .vault
        .entries
        .get(id)
        .ok_or_else(|| format!("未找到连接凭据：{id}"))?;
    unprotect_secret(protected, vault_master_password(state)?, &credential_context(id))
        .map_err(|error| format!("凭据解密失败：{error}"))
}

fn store_credential(
    state: &mut CredentialVaultState,
    id: String,
    plaintext: &str,
) -> Result<String, String> {
    let protected = protect_secret(
        plaintext,
        state.vault.mode,
        vault_master_password(state)?,
        &credential_context(&id),
    )
    .map_err(|error| format!("凭据加密失败：{error}"))?;
    state.vault.entries.insert(id.clone(), protected);
    Ok(id)
}

/// Legacy local obfuscation retained only for one-time migration of pterm1 data.
const SECRET_PREFIX: &str = "pterm1:";

fn secret_obfuscation_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    let material = format!(
        "pandaterm-v1|{}|{}|{}",
        std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "user".into()),
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "host".into()),
        std::env::consts::OS,
    );
    let bytes = material.as_bytes();
    for (i, slot) in key.iter_mut().enumerate() {
        let b = bytes.get(i % bytes.len()).copied().unwrap_or(0);
        *slot = b
            .wrapping_mul(31)
            .wrapping_add((i as u8).wrapping_mul(17))
            .wrapping_add(0xA5);
    }
    key
}

fn deobfuscate_secret(stored: &str) -> String {
    let Some(rest) = stored.strip_prefix(SECRET_PREFIX) else {
        return stored.to_string();
    };
    let Ok(bytes) = base64_decode(rest) else {
        return stored.to_string();
    };
    let key = secret_obfuscation_key();
    let mut out = Vec::with_capacity(bytes.len());
    for (i, b) in bytes.iter().enumerate() {
        out.push(b ^ key[i % 32] ^ ((i as u8).wrapping_mul(31)));
    }
    String::from_utf8(out).unwrap_or_else(|_| stored.to_string())
}

fn load_known_hosts() -> HashMap<String, String> {
    let Ok(path) = known_hosts_path() else {
        return HashMap::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_known_hosts(hosts: &HashMap<String, String>) -> Result<(), String> {
    let path = known_hosts_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("known_hosts 目录创建失败：{e}"))?;
    }
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("known_hosts 序列化失败：{e}"))?;
    fs::write(path, content).map_err(|e| format!("known_hosts 写入失败：{e}"))
}

fn host_key_fingerprint(key: &russh::keys::PublicKey) -> String {
    // algorithm + base64 public key material for stable MITM detection.
    use russh::keys::PublicKeyBase64;
    let alg = key.algorithm().to_string();
    format!("{alg}:{}", key.public_key_base64())
}

fn verify_or_trust_host_key(host_port: &str, key: &russh::keys::PublicKey) -> Result<bool, String> {
    let fingerprint = host_key_fingerprint(key);
    let mut hosts = load_known_hosts();
    match hosts.get(host_port) {
        Some(known) if known == &fingerprint => Ok(true),
        Some(known) => {
            eprintln!(
                "[SSH] host key mismatch for {host_port}: known={known} now={fingerprint}"
            );
            Err(format!(
                "主机密钥已变更（{host_port}），可能存在中间人风险。若确认服务器已重装，请删除 ~/.pandaterm/known_hosts.json 后重试"
            ))
        }
        None => {
            hosts.insert(host_port.to_string(), fingerprint);
            save_known_hosts(&hosts)?;
            eprintln!("[SSH] trusted new host key for {host_port}");
            Ok(true)
        }
    }
}

fn load_persistent_sessions() -> Result<Vec<Session>, String> {
    let path = session_store_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("连接配置读取失败：{error}")),
    };

    serde_json::from_str::<Vec<Session>>(&content)
        .map_err(|error| format!("连接配置已损坏，已进入只读保护状态：{error}"))
}

fn save_persistent_sessions(sessions: &[Session]) -> Result<(), String> {
    let path = session_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("连接配置目录创建失败：{error}"))?;
    }

    let content = serde_json::to_string_pretty(sessions)
        .map_err(|error| format!("连接配置序列化失败：{error}"))?;
    atomic_write_text(&path, &content)
        .map_err(|error| format!("连接配置保存失败：{error}"))
}

fn same_session_identity(left: &Session, right: &Session) -> bool {
    left.name.eq_ignore_ascii_case(&right.name)
        && left.host.eq_ignore_ascii_case(&right.host)
        && left.port == right.port
        && left.username.eq_ignore_ascii_case(&right.username)
}

fn load_initial_sessions() -> Result<Vec<Session>, String> {
    let mut sessions = load_persistent_sessions()?;

    for xshell_session in load_xshell_sessions() {
        if sessions
            .iter()
            .any(|session| same_session_identity(session, &xshell_session))
        {
            continue;
        }
        sessions.push(xshell_session);
    }

    // Preserve the persisted order so a user's custom drag-and-drop ordering
    // survives restarts. Newly imported Xshell sessions are already sorted by
    // name inside load_xshell_sessions and simply appended above.
    Ok(sessions)
}

fn migrate_legacy_credentials(
    sessions: &mut [Session],
    credentials: &mut CredentialVaultState,
) -> Result<bool, String> {
    let mut changed = false;
    for session in sessions {
        let candidate = match &mut session.auth {
            AuthType::Password { secret_id } => Some((secret_id, "password")),
            AuthType::KeyboardInteractive { response_secret_id } => {
                Some((response_secret_id, "keyboard-interactive"))
            }
            AuthType::PrivateKey {
                passphrase_secret_id: Some(passphrase),
                ..
            } => Some((passphrase, "private-key-passphrase")),
            AuthType::PrivateKey {
                passphrase_secret_id: None,
                ..
            }
            | AuthType::Agent
            | AuthType::Gssapi { .. } => None,
        };

        let Some((value, kind)) = candidate else {
            continue;
        };
        if value.is_empty() || is_credential_id(value) {
            continue;
        }

        let plaintext = deobfuscate_secret(value);
        let id = credential_id(session.id, kind);
        *value = store_credential(credentials, id, &plaintext)?;
        changed = true;
    }
    Ok(changed)
}

fn load_secure_state() -> (Vec<Session>, CredentialVaultState, Option<String>) {
    let (mut sessions, session_store_error) = match load_initial_sessions() {
        Ok(sessions) => (sessions, None),
        Err(error) => {
            eprintln!("[Session] {error}");
            (Vec::new(), Some(error))
        }
    };
    let (vault, load_error) = match load_credential_vault() {
        Ok(vault) => (vault, None),
        Err(error) => {
            eprintln!("[Credential] {error}");
            (CredentialVault::default(), Some(error))
        }
    };
    let mut credentials = CredentialVaultState {
        vault,
        master_password: None,
        load_error,
    };

    if credentials.load_error.is_none() && session_store_error.is_none() {
        match migrate_legacy_credentials(&mut sessions, &mut credentials) {
            Ok(true) => {
                if let Err(error) = save_credential_vault(&credentials.vault)
                    .and_then(|_| save_persistent_sessions(&sessions))
                {
                    eprintln!("[Credential] automatic migration failed: {error}");
                }
            }
            Ok(false) => {}
            Err(error) => eprintln!("[Credential] automatic migration failed: {error}"),
        }
    }

    (sessions, credentials, session_store_error)
}

fn resolved_session(session: &Session, credentials: &CredentialVaultState) -> Result<Session, String> {
    let mut resolved = session.clone();
    match &mut resolved.auth {
        AuthType::Password { secret_id } => {
            *secret_id = resolve_credential(credentials, secret_id)?;
        }
        AuthType::KeyboardInteractive { response_secret_id } => {
            *response_secret_id = resolve_credential(credentials, response_secret_id)?;
        }
        AuthType::PrivateKey {
            passphrase_secret_id: Some(passphrase),
            ..
        } => {
            *passphrase = resolve_credential(credentials, passphrase)?;
        }
        AuthType::PrivateKey {
            passphrase_secret_id: None,
            ..
        }
        | AuthType::Agent
        | AuthType::Gssapi { .. } => {}
    }
    Ok(resolved)
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

fn local_shell_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "PowerShell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    }
}

fn local_prompt(path: &Path) -> String {
    if cfg!(target_os = "windows") {
        format!("PS {}>", format_path(path.to_path_buf()))
    } else {
        format!("{} $", format_path(path.to_path_buf()))
    }
}

fn is_clear_command(command: &str) -> bool {
    matches!(command.trim().to_lowercase().as_str(), "clear" | "cls")
}

fn shell_cwd_marker() -> &'static str {
    "__PANDATERM_CWD__"
}

fn normalize_shell_text(text: String) -> String {
    text.replace("\r\n", "\n")
}

fn decode_shell_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return normalize_shell_text(text);
    }

    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = GBK.decode(bytes);
        normalize_shell_text(text.into_owned())
    }

    #[cfg(not(target_os = "windows"))]
    {
        normalize_shell_text(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn decode_terminal_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return text;
    }

    #[cfg(target_os = "windows")]
    {
        let (text, _, _) = GBK.decode(bytes);
        text.into_owned()
    }

    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn split_shell_output(output: String) -> (String, Option<String>) {
    if let Some(index) = output.rfind(shell_cwd_marker()) {
        let before = output[..index].trim_end_matches(['\n', '\r']).to_string();
        let after = output[index + shell_cwd_marker().len()..].trim();
        let cwd = if after.is_empty() {
            None
        } else {
            Some(after.to_string())
        };
        (before, cwd)
    } else {
        (output.trim_end_matches(['\n', '\r']).to_string(), None)
    }
}

async fn run_local_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    if cfg!(target_os = "windows") {
        run_windows_shell_command(command, cwd).await
    } else {
        run_unix_shell_command(command, cwd).await
    }
}

async fn run_windows_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    let script = format!(
        "& {{ param([string]$workingDirectory, [string]$userCommand) Set-Location -LiteralPath $workingDirectory; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); Invoke-Expression $userCommand; $exitCode = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 0 }}; Write-Output ('{}' + (Get-Location).Path); exit $exitCode }}",
        shell_cwd_marker()
    );

    let output = Command::new("powershell.exe")
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .arg(format_path(cwd.to_path_buf()))
        .arg(command)
        .output()
        .await
        .map_err(|error| error.to_string())?;

    let stdout = decode_shell_text(&output.stdout);
    let stderr = decode_shell_text(&output.stderr);
    let (stdout_body, next_cwd) = split_shell_output(stdout);
    let body = [stdout_body, stderr]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((body, next_cwd, output.status.success()))
}

async fn run_unix_shell_command(
    command: &str,
    cwd: &Path,
) -> Result<(String, Option<String>, bool), String> {
    let shell = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    let script = format!(
        "cd -- \"$1\" || exit 1\neval \"$2\"\nstatus=$?\nprintf '\n%s%s\n' '{}' \"$PWD\"\nexit $status",
        shell_cwd_marker()
    );

    let output = Command::new(shell)
        .arg("-lc")
        .arg(script)
        .arg("pandaterm")
        .arg(format_path(cwd.to_path_buf()))
        .arg(command)
        .output()
        .await
        .map_err(|error| error.to_string())?;

    let stdout = decode_shell_text(&output.stdout);
    let stderr = decode_shell_text(&output.stderr);
    let (stdout_body, next_cwd) = split_shell_output(stdout);
    let body = [stdout_body, stderr]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((body, next_cwd, output.status.success()))
}

fn local_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        rows: rows.unwrap_or(32).max(1),
        cols: cols.unwrap_or(120).max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn local_pty_command(cwd: &Path) -> CommandBuilder {
    if cfg!(target_os = "windows") {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command.arg("-NoExit");
        command.arg("-NoProfile");
        command.arg("-Command");
        command.arg(r#"[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); function global:prompt { "PS $($PWD.Path)>" }"#);
        command.cwd(cwd);
        command
    } else {
        let mut command = CommandBuilder::new(if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/bash"
        });
        command.cwd(cwd);
        command
    }
}

struct SshHandler {
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
        match verify_or_trust_host_key(&self.host_port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => Ok(false),
            Err(message) => {
                if let Ok(mut slot) = self.host_key_error.lock() {
                    *slot = Some(message);
                }
                Ok(false)
            }
        }
    }
}

async fn connect_russh_session(
    app: &AppHandle,
    terminal_id: &str,
    session: &Session,
) -> Result<russh::client::Handle<SshHandler>, String> {
    emit_remote_log(
        app,
        terminal_id,
        format!("Connecting to {}:{}...", session.host, session.port),
    );

    let config = Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        window_size: 16 * 1024 * 1024,
        channel_buffer_size: 1024,
        ..russh::client::Config::default()
    });
    let host_port = format!("{}:{}", session.host, session.port);
    let host_key_error = Arc::new(std::sync::Mutex::new(None));
    let handler = SshHandler {
        host_port: host_port.clone(),
        host_key_error: Arc::clone(&host_key_error),
    };

    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, (session.host.as_str(), session.port), handler),
    )
    .await
    .map_err(|_| format!("SSH 连接超时（15s）：{}", session.host))?
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

async fn spawn_russh_terminal(
    app: AppHandle,
    terminal_id: String,
    session_id: Uuid,
    handle: russh::client::Handle<SshHandler>,
) -> Result<RemoteTerminalSession, String> {
    emit_remote_log(&app, &terminal_id, "Opening channel...");

    let mut channel = handle
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

    tokio::spawn(async move {
        loop {
            tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(RemoteTerminalCommand::Write(data)) => {
                            if !data.is_empty() {
                                if let Err(error) = channel.data(data.as_bytes()).await {
                                    emit_terminal_output(
                                        &app,
                                        terminal_id_clone.clone(),
                                        format!("\r\n终端写入失败：{error}\r\n"),
                                    );
                                    break;
                                }
                            }
                        }
                        Some(RemoteTerminalCommand::Resize { cols, rows }) => {
                            let _ = channel
                                .window_change(cols as u32, rows as u32, 0, 0)
                                .await;
                        }
                        Some(RemoteTerminalCommand::Close) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            emit_terminal_output(
                                &app,
                                terminal_id_clone.clone(),
                                decode_terminal_bytes(data),
                            );
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            emit_terminal_output(
                                &app,
                                terminal_id_clone.clone(),
                                decode_terminal_bytes(data),
                            );
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        closed_clone.store(true, Ordering::SeqCst);
        close_notification_clone.notify_one();
        let _ = channel.eof().await;
        let _ = channel.close().await;
        emit_terminal_output(&app, terminal_id_clone, "\r\n连接已关闭\r\n".to_string());
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
fn shell_quote(value: &str) -> String {
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

/// Parse the structured output produced by the remote `find` listing command.
fn parse_remote_listing(text: &str) -> Result<LocalDirectoryListing, String> {
    let mut lines = text.lines();
    let path_line = lines.next().ok_or_else(|| "远程目录响应格式异常".to_string())?;
    let path = path_line.strip_prefix("P:").unwrap_or(path_line).to_string();
    let parent_line = lines.next().unwrap_or("");
    let parent = parent_line
        .strip_prefix("D:")
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut entries = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '\t');
        let type_char = parts.next().unwrap_or("");
        let size_str = parts.next().unwrap_or("0");
        let mtime_str = parts.next().unwrap_or("0");
        let name = parts.next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let entry_type = match type_char.chars().next() {
            Some('d') => "directory",
            _ => "file",
        }
        .to_string();
        let size: u64 = size_str.parse().unwrap_or(0);
        let modified_ms = mtime_str
            .split('.')
            .next()
            .and_then(|seconds| seconds.parse::<u64>().ok())
            .map(|seconds| seconds as u128 * 1000);
        let full_path = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };
        entries.push(LocalDirectoryEntry {
            name: name.to_string(),
            path: full_path,
            entry_type,
            size,
            modified_ms,
        });
    }

    entries.sort_by(|left, right| {
        left.entry_type
            .cmp(&right.entry_type)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(LocalDirectoryListing {
        path,
        parent,
        entries,
    })
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
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    writer: SharedWriter,
) {
    eprintln!("[PTY] spawn_terminal_reader started for terminal_id={}", session_id);
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    eprintln!("[PTY] reader returned 0 (EOF) for terminal_id={}", session_id);
                    break;
                }
                Ok(size) => {
                    let decoded = decode_terminal_bytes(&buffer[..size]);

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
                        emit_terminal_output(&app, session_id.clone(), visible_output);
                    }
                }
                Err(error) => {
                    eprintln!("[PTY] reader error for terminal_id={}: {}", session_id, error);
                    emit_terminal_output(
                        &app,
                        session_id.clone(),
                        format!("\r\n终端读取失败：{error}\r\n"),
                    );
                    break;
                }
            }
        }
    });
}

fn default_local_path() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .filter(|path| path.is_dir())
    .ok_or_else(|| "无法定位用户目录".to_string())?;

    Ok(home)
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

fn resolve_local_path(path: Option<String>) -> Result<PathBuf, String> {
    match path.filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(PathBuf::from(value)),
        None => default_local_path(),
    }
}

fn format_path(path: PathBuf) -> String {
    let path_text = path.to_string_lossy();

    if cfg!(target_os = "windows") {
        if let Some(stripped) = path_text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", stripped);
        }

        if let Some(stripped) = path_text.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }

    path_text.to_string()
}

#[tauri::command]
async fn list_local_directory(path: Option<String>) -> Result<LocalDirectoryListing, String> {
    // On Windows, a special "root" path lists available drive letters
    // so users can navigate between drives like in File Explorer.
    if cfg!(target_os = "windows") {
        let resolved = resolve_local_path(path.clone())?;
        // If the user navigated to the virtual root (e.g. by going "up" from C:\),
        // list all available drive letters.
        if resolved.to_string_lossy().trim_end_matches('\\').is_empty()
            || resolved.to_string_lossy() == "This PC"
            || resolved.to_string_lossy() == "此电脑"
        {
            return list_windows_drives();
        }
    }

    let directory = resolve_local_path(path)?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();

    for entry in fs::read_dir(&canonical_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let entry_type = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        }
        .to_string();
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());

        entries.push(LocalDirectoryEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: format_path(entry.path()),
            entry_type,
            size: metadata.len(),
            modified_ms,
        });
    }

    entries.sort_by(|left, right| {
        left.entry_type
            .cmp(&right.entry_type)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    // On Windows, when the current directory is a drive root (e.g. C:\),
    // set parent to a virtual "This PC" so users can navigate to other drives.
    let parent_path = if cfg!(target_os = "windows") {
        let canonical_str = canonical_directory.to_string_lossy();
        // e.g. canonical is "\\?\C:\" — parent would be "\\?\C" which is invalid
        // Instead, set parent to the virtual root
        if canonical_str.ends_with(":\\") || canonical_str.ends_with(":\\\\") {
            Some("此电脑".to_string())
        } else {
            canonical_directory
                .parent()
                .map(|parent| format_path(parent.to_path_buf()))
        }
    } else {
        canonical_directory
            .parent()
            .map(|parent| format_path(parent.to_path_buf()))
    };

    Ok(LocalDirectoryListing {
        path: format_path(canonical_directory.clone()),
        parent: parent_path,
        entries,
    })
}

fn windows_drive_letters() -> std::ops::RangeInclusive<char> {
    'A'..='Z'
}

/// List available Windows drive letters as directory entries.
fn list_windows_drives() -> Result<LocalDirectoryListing, String> {
    let mut entries = Vec::new();
    for letter in windows_drive_letters() {
        let drive = format!("{letter}:\\");
        if PathBuf::from(&drive).is_dir() {
            entries.push(LocalDirectoryEntry {
                name: format!("本地磁盘 ({letter}:)"),
                path: drive.clone(),
                entry_type: "directory".to_string(),
                size: 0,
                modified_ms: None,
            });
        }
    }
    Ok(LocalDirectoryListing {
        path: "此电脑".to_string(),
        parent: None,
        entries,
    })
}

#[tauri::command]
async fn read_local_file_preview(path: String) -> Result<LocalFilePreview, String> {
    let file_path = PathBuf::from(path);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&canonical_file).map_err(|error| error.to_string())?;

    if !metadata.is_file() {
        return Err("只能预览文件".to_string());
    }

    let read_size = metadata.len().min(LOCAL_FILE_PREVIEW_LIMIT) as usize;
    let mut bytes = Vec::with_capacity(read_size);
    fs::File::open(&canonical_file)
        .map_err(|error| error.to_string())?
        .take(LOCAL_FILE_PREVIEW_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "暂不支持预览二进制文件".to_string())?;

    Ok(LocalFilePreview {
        path: format_path(canonical_file.clone()),
        name: canonical_file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format_path(canonical_file.clone())),
        size: metadata.len(),
        content,
        truncated: metadata.len() > LOCAL_FILE_PREVIEW_LIMIT,
    })
}

#[tauri::command]
async fn read_local_file_full(path: String) -> Result<LocalFilePreview, String> {
    let file_path = PathBuf::from(path);
    let canonical_file = file_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&canonical_file).map_err(|error| error.to_string())?;

    if !metadata.is_file() {
        return Err("只能读取文件".to_string());
    }

    if metadata.len() > LOCAL_FILE_FULL_LIMIT {
        return Err(format!(
            "文件过大（{} 字节），编辑器最多支持 {} 字节的文件",
            metadata.len(),
            LOCAL_FILE_FULL_LIMIT
        ));
    }

    let bytes = fs::read(&canonical_file).map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "暂不支持编辑二进制文件".to_string())?;

    Ok(LocalFilePreview {
        path: format_path(canonical_file.clone()),
        name: canonical_file
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format_path(canonical_file.clone())),
        size: metadata.len(),
        content,
        truncated: false,
    })
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
            size,
            REMOTE_FILE_FULL_LIMIT
        ));
    }

    let (output, stderr, exit_code) =
        exec_remote_command_full(&handle, &format!("cat {quoted}")).await?;
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

const REMOTE_UPLOAD_COMPLETION_MARKER: &[u8] = b"__PANDATERM_UPLOAD_COMPLETE__";

fn validate_remote_upload_completion(
    exit_code: Option<i32>,
    completion_marker_seen: bool,
) -> Result<(), String> {
    match (exit_code, completion_marker_seen) {
        (Some(0) | None, true) => Ok(()),
        (Some(0), false) => Err("远程写入失败：未收到完成标记".to_string()),
        (Some(code), _) => Err(format!("远程写入失败，退出码: {code}")),
        (None, false) => Err("远程写入失败：SSH 通道未返回退出状态或完成标记".to_string()),
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
        while let Some(msg) = reader.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    let remaining = 128usize.saturating_sub(completion_output.len());
                    completion_output.extend_from_slice(&data[..data.len().min(remaining)]);
                }
                russh::ChannelMsg::ExtendedData { .. } => {}
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
        (exit_code, completion_marker_seen)
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
    let (observed_exit_code, completion_marker_seen) = read_task
        .await
        .map_err(|error| format!("等待远程写入确认失败：{error}"))?;
    let _ = writer.close().await;
    validate_remote_upload_completion(observed_exit_code, completion_marker_seen)
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
        while let Some(msg) = reader.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => {
                    let remaining = 128usize.saturating_sub(completion_output.len());
                    completion_output.extend_from_slice(&data[..data.len().min(remaining)]);
                }
                russh::ChannelMsg::ExtendedData { .. } => {}
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
        (exit_code, completion_marker_seen)
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
    let (observed_exit_code, completion_marker_seen) = read_task
        .await
        .map_err(|error| format!("等待远程写入确认失败：{error}"))?;
    let _ = writer.close().await;
    validate_remote_upload_completion(observed_exit_code, completion_marker_seen)
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
        tokio::time::sleep(Duration::from_secs(300)).await;
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

/// Recursively upload a local directory to a remote server via SFTP/SSH.
/// Creates the directory structure on the remote, then uploads each file.
/// Returns the number of files uploaded and directories created.
/// Decide how many files to upload in parallel based on the local machine's
/// current CPU load: 1 when the CPU is busy, 2 when it's idle/free.
/// Reuses the cached `local_sys_monitor` so we don't spin up a fresh sysinfo
/// instance per upload. The threshold (60%) mirrors total CPU usage as shown
/// in Task Manager / top.
fn recommended_upload_concurrency(state: &AppState) -> usize {
    const CPU_BUSY_THRESHOLD: f32 = 60.0;
    let usage = {
        use sysinfo::{System, CpuRefreshKind, RefreshKind};
        let mut guard = state.local_sys_monitor.lock().unwrap();
        match guard.as_mut() {
            Some(s) => {
                s.refresh_cpu_usage();
                s.global_cpu_usage()
            }
            None => {
                // First call: two samples establish a usable delta baseline.
                let mut s = System::new_with_specifics(
                    RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
                );
                s.refresh_cpu_usage();
                std::thread::sleep(std::time::Duration::from_millis(500));
                s.refresh_cpu_usage();
                let u = s.global_cpu_usage();
                *guard = Some(s);
                u
            }
        }
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
fn get_upload_concurrency(state: State<'_, Arc<AppState>>) -> usize {
    recommended_upload_concurrency(&state)
}

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

            if entry_path.is_dir() {
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
    let concurrency = recommended_upload_concurrency(&state).max(1);
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

/// Simple base64 encoder (avoids adding the base64 crate dependency).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Simple base64 decoder.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 256] = &{
        let mut t = [255u8; 256];
        let mut i = 0;
        while i < 26 { t[(b'A' + i as u8) as usize] = i as u8; i += 1; }
        let mut i = 0;
        while i < 26 { t[(b'a' + i as u8) as usize] = (26 + i) as u8; i += 1; }
        let mut i = 0;
        while i < 10 { t[(b'0' + i as u8) as usize] = (52 + i) as u8; i += 1; }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let filtered: Vec<u8> = input.bytes().filter(|&b| b != b'\n' && b != b'\r' && b != b' ').collect();
    if filtered.is_empty() {
        return Ok(Vec::new());
    }
    if !filtered.len().is_multiple_of(4) {
        return Err(format!("无效的 base64 长度: {}", filtered.len()));
    }
    let mut out = Vec::with_capacity(filtered.len() / 4 * 3);
    for chunk in filtered.chunks(4) {
        let v0 = TABLE[chunk[0] as usize];
        let v1 = TABLE[chunk[1] as usize];
        let v2 = if chunk[2] == b'=' { 0 } else { TABLE[chunk[2] as usize] };
        let v3 = if chunk[3] == b'=' { 0 } else { TABLE[chunk[3] as usize] };
        if v0 == 255 || v1 == 255 {
            return Err("无效的 base64 字符".to_string());
        }
        let n = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(n as u8);
        }
    }
    Ok(out)
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

/// Build the shell command for extracting an archive into a destination
/// directory. Returns an empty string for unsupported formats.
fn extract_command(archive_path: &str, dest_dir: &str) -> String {
    let lower = archive_path.to_lowercase();
    let q = shell_quote(archive_path);
    let d = shell_quote(dest_dir);
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        format!("mkdir -p {d} && tar xzf {q} -C {d}")
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        format!("mkdir -p {d} && tar xjf {q} -C {d}")
    } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        format!("mkdir -p {d} && tar xJf {q} -C {d}")
    } else if lower.ends_with(".tar") {
        format!("mkdir -p {d} && tar xf {q} -C {d}")
    } else if lower.ends_with(".zip") {
        // Try unzip first, fall back to python3's zipfile module if unzip is missing.
        format!(
            "mkdir -p {d} && (command -v unzip >/dev/null 2>&1 && unzip -o {q} -d {d} || python3 -c \"import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])\" {q} {d})"
        )
    } else if lower.ends_with(".gz") {
        format!("gunzip -f {q}")
    } else if lower.ends_with(".bz2") {
        format!("bunzip2 -f {q}")
    } else if lower.ends_with(".xz") {
        format!("unxz -f {q}")
    } else if lower.ends_with(".7z") {
        format!("7z x {q} -o{d} -y")
    } else if lower.ends_with(".rar") {
        format!("unrar x {q} {d}/")
    } else {
        String::new()
    }
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

/// Extract a local archive using platform-appropriate tools.
/// On Windows: PowerShell `Expand-Archive` for zip, `tar` for tar variants.
/// On Unix: standard shell tools via `sh -c`.
fn extract_local_archive(archive_path: &str, dest_dir: &str) -> Result<String, String> {
    let lower = archive_path.to_lowercase();

    // Ensure destination exists.
    fs::create_dir_all(dest_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;

    if cfg!(windows) {
        // Use std::process::Command directly (no cmd /C wrapper) so PATH
        // resolution works and we avoid quote-escaping hell.
        // Wrap in try/catch with explicit exit so PowerShell returns non-zero
        // on error (by default Expand-Archive errors don't set $LASTEXITCODE).
        let result = if lower.ends_with(".zip") {
            let ps_script = format!(
                "try {{ Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force -ErrorAction Stop; exit 0 }} catch {{ Write-Error $_.Exception.Message; exit 1 }}",
                archive_path.replace('\'', "''"),
                dest_dir.replace('\'', "''")
            );
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &ps_script,
                ])
                .output()
        } else if lower.ends_with(".tar.gz")
            || lower.ends_with(".tgz")
            || lower.ends_with(".tar.bz2")
            || lower.ends_with(".tbz2")
            || lower.ends_with(".tar.xz")
            || lower.ends_with(".txz")
            || lower.ends_with(".tar")
        {
            std::process::Command::new("tar")
                .args(["xf", archive_path, "-C", dest_dir])
                .output()
        } else if lower.ends_with(".7z") {
            std::process::Command::new("7z")
                .args(["x", archive_path, &format!("-o{dest_dir}"), "-y"])
                .output()
        } else if lower.ends_with(".gz") {
            std::process::Command::new("gzip")
                .args(["-d", "-f", archive_path])
                .output()
        } else if lower.ends_with(".bz2") {
            std::process::Command::new("bzip2")
                .args(["-d", "-f", archive_path])
                .output()
        } else if lower.ends_with(".xz") {
            std::process::Command::new("xz")
                .args(["-d", "-f", archive_path])
                .output()
        } else {
            return Err(format!("本地不支持解压此格式: {archive_path}"));
        };

        let output = result.map_err(|e| format!("执行解压失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                format!("退出码: {:?}", output.status.code())
            };
            return Err(format!("解压失败: {detail}"));
        }
        // PowerShell may return exit 0 even on error — double check stderr.
        if !stderr.is_empty() && stderr.contains("Error") {
            return Err(format!("解压失败: {stderr}"));
        }
    } else {
        let cmd = extract_command(archive_path, dest_dir);
        if cmd.is_empty() {
            return Err(format!("不支持的压缩包格式: {archive_path}"));
        }
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .map_err(|e| format!("执行解压失败（sh）: {e}"))?;

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
            return Err(format!("解压失败: {detail}"));
        }
    }
    Ok("解压完成".to_string())
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
            (
                "sh",
                vec![
                    "-c".to_string(),
                    format!(
                        "rm -f '{}' && zip -r '{}' '{}'",
                        archive_path.to_string_lossy(),
                        archive_path.to_string_lossy(),
                        source_path
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

/// System monitor data structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SystemMonitorData {
    hostname: String,
    os_name: String,
    os_version: String,
    kernel_version: String,
    uptime_seconds: u64,
    cpu_count: u32,
    cpu_usage_percent: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_available_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    disk_total_bytes: u64,
    disk_used_bytes: u64,
    disk_available_bytes: u64,
    load_avg_1min: f64,
    load_avg_5min: f64,
    load_avg_15min: f64,
    cpu_model: String,
    network_rx_bytes: u64,
    network_tx_bytes: u64,
    processes: u32,
}

/// Single process info for the process-list panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    status: String,
    cpu_usage_percent: f64,
    memory_bytes: u64,
    disk_bytes_per_sec: f64,
    network_bytes_per_sec: f64,
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

        // Use ps to gather process info, sorted by CPU usage.
        // Note: The command is sent via SSH exec which may wrap it in single quotes on
        // the remote side (bash -c '<command>'), so we must avoid ANY single quotes.
        //
        // Strategy: compute nproc and total memory first, then pass them into awk via -v
        // so the awk script itself only uses awk field variables ($2, $3…) which need
        // \-escaping inside bash double-quotes.  Using a Rust raw string (r#"…"#) avoids
        // all Rust-level escaping — the string content is exactly what the remote shell
        // receives.
        //
        // ps aux %CPU is per-single-core; dividing by nproc gives % of total CPU.
        // ps aux %MEM * total_mem / 100 gives actual bytes.  We use printf %d for memory
        // to avoid scientific notation (e.g. 3.7e+07) that u64::parse cannot handle.
        //
        // Output format: P \t pid \t name \t stat \t cpu_total% \t mem_bytes \t 0 \t 0
        let cmd = r#"nproc=$(nproc 2>/dev/null||echo 1);mem_total=$(awk "/^MemTotal/{print \$2*1024}" /proc/meminfo 2>/dev/null||echo 0);ps aux --sort=-%cpu 2>/dev/null | head -50 | awk -v nc="$nproc" -v mt="$mem_total" "BEGIN{OFS=\"\t\"}NR>1{pid=\$2;cpu=\$3;mem=\$4;stat=substr(\$8,1,1);cmd=\$11;for(i=12;i<=NF;i++)cmd=cmd FS \$i;if(length(cmd)>30)cmd=substr(cmd,1,30);printf \"P\t%d\t%s\t%s\t%.1f\t%d\t0\t0\n\",pid,cmd,stat,cpu/nc,int(mem*mt/100)}" && echo END_PROCESS_LIST"#;
        let (stdout, stderr, code) = exec_remote_command_full(&handle, cmd).await?;
        if code != Some(0) {
            return Err(format!("获取进程列表失败: {}", String::from_utf8_lossy(&stderr)));
        }

        let output = String::from_utf8_lossy(&stdout);
        let mut processes = Vec::new();
        for line in output.lines() {
            if line == "END_PROCESS_LIST" { break; }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 7 || parts[0] != "P" { continue; }
            let pid = parts[1].parse::<u32>().ok().unwrap_or(0);
            let name = parts[2].to_string();
            let status = parts[3].to_string();
            let cpu = parts[4].parse::<f64>().ok().unwrap_or(0.0);
            let mem_bytes = parts[5].parse::<u64>().ok().unwrap_or(0);

            processes.push(ProcessInfo {
                pid,
                name,
                status,
                cpu_usage_percent: cpu.clamp(0.0, 100.0),
                memory_bytes: mem_bytes,
                disk_bytes_per_sec: 0.0,
                network_bytes_per_sec: 0.0,
            });
        }
        Ok(processes)
    } else {
        // Local: use sysinfo crate
        use sysinfo::{ProcessesToUpdate, ProcessRefreshKind};

        let mut guard = state.local_sys_monitor.lock().unwrap();
        let sys = match guard.as_mut() {
            Some(s) => s,
            None => {
                // First call: initialise the System instance (same as get_system_monitor).
                use sysinfo::{System, CpuRefreshKind, RefreshKind};
                let mut s = System::new_with_specifics(
                    RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
                );
                s.refresh_cpu_usage();
                std::thread::sleep(std::time::Duration::from_millis(500));
                s.refresh_cpu_usage();
                *guard = Some(s);
                guard.as_mut().unwrap()
            }
        };

        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        // sysinfo::Process::cpu_usage() returns % of a *single core* (0-100 per core),
        // so on a multi-core machine values can exceed 100 and sum to >100 across all
        // processes.  Divide by CPU count to get % of *total* CPU, matching what users
        // expect from Task Manager / top.
        let cpu_count = sys.cpus().len() as f64;

        let processes: Vec<ProcessInfo> = sys.processes()
            .values()
            .filter(|p| p.cpu_usage() > 0.01 || p.memory() > 1024 * 1024)
            .map(|p| ProcessInfo {
                pid: p.pid().as_u32(),
                name: p.name().to_string_lossy().to_string(),
                status: {
                    let s = p.status();
                    match s {
                        sysinfo::ProcessStatus::Run => "Running".to_string(),
                        sysinfo::ProcessStatus::Sleep => "Sleeping".to_string(),
                        sysinfo::ProcessStatus::Idle => "Idle".to_string(),
                        sysinfo::ProcessStatus::Zombie => "Zombie".to_string(),
                        sysinfo::ProcessStatus::Stop => "Stopped".to_string(),
                        _ => "Unknown".to_string(),
                    }
                },
                cpu_usage_percent: (p.cpu_usage() as f64 / cpu_count).clamp(0.0, 100.0),
                memory_bytes: p.memory(),
                disk_bytes_per_sec: 0.0,
                network_bytes_per_sec: 0.0,
            })
            .collect();

        // Sort by CPU usage descending, then memory descending
        let mut sorted = processes;
        sorted.sort_by(|a, b| {
            b.cpu_usage_percent
                .partial_cmp(&a.cpu_usage_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
        });
        // Keep top 50
        sorted.truncate(50);
        Ok(sorted)
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

        // Collect all info in one composite command to minimize SSH round-trips.
        let cmd = r#"
HOSTNAME=$(hostname 2>/dev/null || echo unknown)
OS_NAME=$(cat /etc/os-release 2>/dev/null | grep '^NAME=' | head -1 | sed 's/NAME="//;s/"$//' || echo Linux)
OS_VER=$(cat /etc/os-release 2>/dev/null | grep '^VERSION=' | head -1 | sed 's/VERSION="//;s/"$//' || echo unknown)
KERNEL=$(uname -r 2>/dev/null || echo unknown)
UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{print int($1)}' || echo 0)
CPU_COUNT=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
CPU_MODEL=$(grep '^model name' /proc/cpuinfo 2>/dev/null | head -1 | sed 's/model name.*: //' || echo unknown)

# CPU usage: sample over 1 second
# Use a single awk read per sample point to avoid inconsistent timestamps.
# idle = $5 (idle) + $6 (iowait); total = sum of all numeric columns.
CPU_SAMPLE1=$(awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle" "total}' /proc/stat)
sleep 1
CPU_SAMPLE2=$(awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle" "total}' /proc/stat)
CPU_IDLE1=$(echo "$CPU_SAMPLE1" | awk '{print $1}')
CPU_TOTAL1=$(echo "$CPU_SAMPLE1" | awk '{print $2}')
CPU_IDLE2=$(echo "$CPU_SAMPLE2" | awk '{print $1}')
CPU_TOTAL2=$(echo "$CPU_SAMPLE2" | awk '{print $2}')
DIFF_TOTAL=$((CPU_TOTAL2 - CPU_TOTAL1))
DIFF_IDLE=$((CPU_IDLE2 - CPU_IDLE1))
if [ "$DIFF_TOTAL" -gt 0 ]; then
  CPU_USAGE=$(awk "BEGIN {printf \"%.1f\", (1 - $DIFF_IDLE/$DIFF_TOTAL)*100}")
else
  CPU_USAGE="0.0"
fi

# Memory
MEM_TOTAL=$(awk '/^MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_AVAILABLE=$(awk '/^MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_USED=$((MEM_TOTAL - MEM_AVAILABLE))

# Swap
SWAP_TOTAL=$(awk '/^SwapTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_FREE=$(awk '/^SwapFree/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))

# Disk (root partition)
DISK_TOTAL=$(df --output=size -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
DISK_USED=$(df --output=used -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
DISK_AVAIL=$(df --output=avail -B1 / 2>/dev/null | tail -1 | tr -d ' ' || echo 0)

# Load average
LOAD=$(cat /proc/loadavg 2>/dev/null || echo "0 0 0")
LOAD1=$(echo "$LOAD" | awk '{print $1}')
LOAD5=$(echo "$LOAD" | awk '{print $2}')
LOAD15=$(echo "$LOAD" | awk '{print $3}')

# Network (first non-lo interface)
NET_IF=$(ls /sys/class/net/ 2>/dev/null | grep -v lo | head -1 || echo eth0)
NET_RX=$(cat /sys/class/net/$NET_IF/statistics/rx_bytes 2>/dev/null || echo 0)
NET_TX=$(cat /sys/class/net/$NET_IF/statistics/tx_bytes 2>/dev/null || echo 0)

# Process count
PROCS=$(ps aux 2>/dev/null | wc -l || echo 0)

echo "MONITOR_RESULT"
echo "hostname=$HOSTNAME"
echo "os_name=$OS_NAME"
echo "os_version=$OS_VER"
echo "kernel=$KERNEL"
echo "uptime=$UPTIME"
echo "cpu_count=$CPU_COUNT"
echo "cpu_usage=$CPU_USAGE"
echo "cpu_model=$CPU_MODEL"
echo "mem_total=$MEM_TOTAL"
echo "mem_available=$MEM_AVAILABLE"
echo "mem_used=$MEM_USED"
echo "swap_total=$SWAP_TOTAL"
echo "swap_used=$SWAP_USED"
echo "disk_total=$DISK_TOTAL"
echo "disk_used=$DISK_USED"
echo "disk_avail=$DISK_AVAIL"
echo "load1=$LOAD1"
echo "load5=$LOAD5"
echo "load15=$LOAD15"
echo "net_rx=$NET_RX"
echo "net_tx=$NET_TX"
echo "procs=$PROCS"
"#;

        let (stdout, stderr, code) = exec_remote_command_full(&handle, cmd).await?;
        if code != Some(0) {
            return Err(format!("获取系统监控数据失败: {}", String::from_utf8_lossy(&stderr)));
        }

        let output = String::from_utf8_lossy(&stdout);
        let mut lines = output.lines().peekable();

        // Find the MONITOR_RESULT marker
        for line in lines.by_ref() {
            if line.trim() == "MONITOR_RESULT" { break; }
        }

        let mut values: HashMap<String, String> = HashMap::new();
        for line in lines {
            if let Some((key, val)) = line.split_once('=') {
                values.insert(key.trim().to_string(), val.trim().to_string());
            }
        }

        Ok(SystemMonitorData {
            hostname: values.get("hostname").cloned().unwrap_or_default(),
            os_name: values.get("os_name").cloned().unwrap_or_default(),
            os_version: values.get("os_version").cloned().unwrap_or_default(),
            kernel_version: values.get("kernel").cloned().unwrap_or_default(),
            uptime_seconds: values.get("uptime").and_then(|v| v.parse().ok()).unwrap_or(0),
            cpu_count: values.get("cpu_count").and_then(|v| v.parse().ok()).unwrap_or(1),
            cpu_usage_percent: values.get("cpu_usage").and_then(|v| v.parse::<f64>().ok()).map(|v| v.clamp(0.0, 100.0)).unwrap_or(0.0),
            memory_total_bytes: values.get("mem_total").and_then(|v| v.parse().ok()).unwrap_or(0),
            memory_used_bytes: values.get("mem_used").and_then(|v| v.parse().ok()).unwrap_or(0),
            memory_available_bytes: values.get("mem_available").and_then(|v| v.parse().ok()).unwrap_or(0),
            swap_total_bytes: values.get("swap_total").and_then(|v| v.parse().ok()).unwrap_or(0),
            swap_used_bytes: values.get("swap_used").and_then(|v| v.parse().ok()).unwrap_or(0),
            disk_total_bytes: values.get("disk_total").and_then(|v| v.parse().ok()).unwrap_or(0),
            disk_used_bytes: values.get("disk_used").and_then(|v| v.parse().ok()).unwrap_or(0),
            disk_available_bytes: values.get("disk_avail").and_then(|v| v.parse().ok()).unwrap_or(0),
            load_avg_1min: values.get("load1").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            load_avg_5min: values.get("load5").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            load_avg_15min: values.get("load15").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            cpu_model: values.get("cpu_model").cloned().unwrap_or_default(),
            network_rx_bytes: values.get("net_rx").and_then(|v| v.parse().ok()).unwrap_or(0),
            network_tx_bytes: values.get("net_tx").and_then(|v| v.parse().ok()).unwrap_or(0),
            processes: values.get("procs").and_then(|v| v.parse().ok()).unwrap_or(0),
        })
    } else {
        // Local: use sysinfo crate with cached System instance.
        // Keeping the System object alive preserves CPU time counters so that
        // each refresh_cpu_usage() computes a correct delta from the last call.
        use sysinfo::{System, Networks, Disks, CpuRefreshKind, RefreshKind};

        let mut guard = state.local_sys_monitor.lock().unwrap();
        let sys = match guard.as_mut() {
            Some(s) => {
                // Subsequent call: just refresh CPU usage (single delta step).
                s.refresh_cpu_usage();
                s.refresh_memory();
                s
            }
            None => {
                // First call: need two samples to establish a baseline.
                let mut s = System::new_with_specifics(
                    RefreshKind::nothing().with_cpu(CpuRefreshKind::everything()),
                );
                s.refresh_cpu_usage();
                thread::sleep(Duration::from_millis(500));
                s.refresh_cpu_usage();
                *guard = Some(s);
                guard.as_mut().unwrap()
            }
        };

        let networks = Networks::new_with_refreshed_list();
        let (net_rx, net_tx) = networks.iter().fold((0u64, 0u64), |(rx, tx), (_, data)| {
            (rx + data.received(), tx + data.transmitted())
        });

        let disks = Disks::new_with_refreshed_list();
        let (disk_total, disk_used, disk_avail) = disks.iter().fold((0u64, 0u64, 0u64), |(t, u, a), disk| {
            let total = disk.total_space();
            let avail = disk.available_space();
            let used = total - avail;
            (t + total, u + used, a + avail)
        });

        Ok(SystemMonitorData {
            hostname: System::host_name().unwrap_or_default(),
            os_name: System::name().unwrap_or_default(),
            os_version: System::os_version().unwrap_or_default(),
            kernel_version: System::kernel_version().unwrap_or_default(),
            uptime_seconds: System::uptime(),
            cpu_count: sys.cpus().len() as u32,
            cpu_usage_percent: sys.global_cpu_usage().clamp(0.0_f32, 100.0_f32) as f64,
            memory_total_bytes: sys.total_memory(),
            memory_used_bytes: sys.used_memory(),
            memory_available_bytes: sys.available_memory(),
            swap_total_bytes: sys.total_swap(),
            swap_used_bytes: sys.used_swap(),
            disk_total_bytes: disk_total,
            disk_used_bytes: disk_used,
            disk_available_bytes: disk_avail,
            load_avg_1min: 0.0, // sysinfo doesn't provide load avg on Windows
            load_avg_5min: 0.0,
            load_avg_15min: 0.0,
            cpu_model: sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
            network_rx_bytes: net_rx,
            network_tx_bytes: net_tx,
            processes: sys.processes().len() as u32,
        })
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

    eprintln!("[PTY] PTY setup complete, spawning reader for terminal_id={}", terminal_id);
    spawn_terminal_reader(app, terminal_id.to_string(), reader, Arc::clone(&shared_writer));

    let mut terminals = state.local_terminals.lock().await;
    terminals.insert(
        terminal_id,
        LocalTerminalSession {
            master: pair.master,
            writer: shared_writer,
            child,
        },
    );

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
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut terminals = state.local_terminals.lock().await;
    if let Some(mut session) = terminals.remove(&terminal_id) {
        let _ = session.child.kill();
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

fn validate_ai_model(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    if model.len() > 200 || model.chars().any(char::is_control) {
        return Err("模型名称无效".to_string());
    }
    Ok(model.to_string())
}

const MAX_AI_MODELS: usize = 500;

/// 校验模型列表，并保证当前选中模型一定在列表中
fn normalize_ai_models(models: &[String], selected: &str) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for model in models {
        let model = validate_ai_model(model)?;
        if !normalized.iter().any(|item| item == &model) {
            normalized.push(model);
        }
        if normalized.len() > MAX_AI_MODELS {
            return Err(format!("模型列表不能超过 {MAX_AI_MODELS} 个"));
        }
    }
    let selected = validate_ai_model(selected)?;
    if !normalized.iter().any(|item| item == &selected) {
        if normalized.len() >= MAX_AI_MODELS {
            return Err(format!("模型列表不能超过 {MAX_AI_MODELS} 个"));
        }
        normalized.insert(0, selected);
    }
    Ok(normalized)
}

/// 规范化“聊天可见”模型：必须是 models 子集，且包含当前 model。
/// 旧配置无 enabled_models 时默认启用全部 models（保持既有行为）。
fn normalize_enabled_ai_models(
    models: &[String],
    enabled: &[String],
    selected: &str,
) -> Result<Vec<String>, String> {
    let catalog: HashSet<&str> = models.iter().map(String::as_str).collect();
    let selected = validate_ai_model(selected)?;
    if !catalog.contains(selected.as_str()) {
        return Err("当前模型不在模型目录中".to_string());
    }

    let mut normalized = Vec::new();
    let source = if enabled.is_empty() {
        models
    } else {
        enabled
    };
    for model in source {
        let model = validate_ai_model(model)?;
        if catalog.contains(model.as_str()) && !normalized.iter().any(|item| item == &model) {
            normalized.push(model);
        }
    }
    if !normalized.iter().any(|item| item == &selected) {
        normalized.insert(0, selected);
    }
    Ok(normalized)
}

/// 同步合并：远端 id 命中本地则覆盖该条目；未命中的本地自定义保留
fn merge_ai_models(existing: &[String], synced: &[String]) -> Result<Vec<String>, String> {
    let mut synced_normalized = Vec::new();
    for model in synced {
        let model = validate_ai_model(model)?;
        if !synced_normalized.iter().any(|item| item == &model) {
            synced_normalized.push(model);
        }
    }
    let synced_set: HashSet<&str> = synced_normalized.iter().map(String::as_str).collect();
    let mut merged = Vec::new();
    for model in existing {
        let model = validate_ai_model(model)?;
        if synced_set.contains(model.as_str()) {
            // 同名自定义被远端覆盖：仅在首次遇到时放入远端规范名
            if !merged.iter().any(|item| item == &model) {
                merged.push(model);
            }
            continue;
        }
        if !merged.iter().any(|item| item == &model) {
            merged.push(model);
        }
    }
    for model in synced_normalized {
        if !merged.iter().any(|item| item == &model) {
            merged.push(model);
        }
    }
    if merged.len() > MAX_AI_MODELS {
        merged.truncate(MAX_AI_MODELS);
    }
    Ok(merged)
}

fn validate_ai_base_url(base_url: &str) -> Result<Url, String> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url = Url::parse(&candidate).map_err(|error| format!("Base URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 只支持 HTTP 或 HTTPS".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Base URL 必须包含有效域名，且不能内嵌账号密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Base URL 不能包含查询参数或片段".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn ai_resource_url(base_url: &str, resource: &str) -> Result<Url, String> {
    let mut url = validate_ai_base_url(base_url)?;
    let path = url.path().trim_end_matches('/');
    let resource = resource.trim_matches('/');
    let endpoint = if path.ends_with(&format!("/{resource}")) || path == resource {
        path.to_string()
    } else if path.is_empty() {
        format!("/{resource}")
    } else {
        format!("{path}/{resource}")
    };
    url.set_path(&endpoint);
    Ok(url)
}

fn ai_chat_completions_url(base_url: &str) -> Result<Url, String> {
    ai_resource_url(base_url, "chat/completions")
}

fn ai_models_url(base_url: &str) -> Result<Url, String> {
    ai_resource_url(base_url, "models")
}

fn ai_config_snapshot(
    config: &AiProviderConfigStore,
    api_key: Option<String>,
    error: Option<String>,
) -> AiProviderConfig {
    AiProviderConfig {
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        models: config.models.clone(),
        enabled_models: config.enabled_models.clone(),
        use_api_key: config.use_api_key,
        api_key_configured: config.api_key_secret_id.is_some(),
        api_key,
        error,
    }
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
    let credentials = state.credentials.lock().await;
    // 解密失败不阻塞配置读取；仅无法回填明文，由前端提示重启
    let api_key = match resolve_ai_api_key(&credentials, config.api_key_secret_id.as_deref()) {
        Ok(key) => key,
        Err(reveal_error) => {
            eprintln!("[AI] reveal api key failed: {reveal_error}");
            None
        }
    };
    Ok(ai_config_snapshot(&config, api_key, error))
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
    let current = state.ai_config.lock().await.clone();
    if request.use_api_key && supplied_key.is_none() && current.api_key_secret_id.is_none() {
        return Err("启用 API Key 时必须输入密钥".to_string());
    }
    let models = normalize_ai_models(
        request.models.as_deref().unwrap_or(&current.models),
        &model,
    )?;
    let enabled_models = normalize_enabled_ai_models(
        &models,
        request
            .enabled_models
            .as_deref()
            .unwrap_or(&current.enabled_models),
        &model,
    )?;

    let mut credentials = state.credentials.lock().await;
    let next_secret_id = if let Some(key) = supplied_key.as_deref() {
        let id = format!("{AI_API_KEY_PREFIX}:{}", Uuid::new_v4());
        Some(store_credential(&mut credentials, id, key.trim())?)
    } else if request.use_api_key {
        current.api_key_secret_id.clone()
    } else {
        None
    };
    let next = AiProviderConfigStore {
        version: AI_CONFIG_VERSION,
        base_url,
        model,
        models,
        enabled_models,
        use_api_key: request.use_api_key,
        api_key_secret_id: next_secret_id,
    };

    if next.api_key_secret_id != current.api_key_secret_id {
        save_credential_vault(&credentials.vault)?;
    }
    save_ai_config(&next)?;
    if let Some(old_id) = current
        .api_key_secret_id
        .filter(|old_id| Some(old_id) != next.api_key_secret_id.as_ref())
    {
        credentials.vault.entries.remove(&old_id);
        if let Err(error) = save_credential_vault(&credentials.vault) {
            eprintln!("[Credential] obsolete AI API key cleanup deferred: {error}");
        }
    }
    let api_key = if let Some(key) = supplied_key {
        Some(key.trim().to_string())
    } else {
        resolve_ai_api_key(&credentials, next.api_key_secret_id.as_deref())?
    };
    *state.ai_config.lock().await = next.clone();
    Ok(ai_config_snapshot(&next, api_key, None))
}

#[tauri::command]
async fn sync_ai_provider_models(
    request: SyncAiModelsRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiProviderConfig, String> {
    if let Some(error) = state.ai_config_error.lock().await.clone() {
        return Err(error);
    }
    let current = state.ai_config.lock().await.clone();
    let base_url = validate_ai_base_url(
        request
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&current.base_url),
    )?
    .to_string();
    let use_api_key = request.use_api_key.unwrap_or(current.use_api_key);
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
            let secret_id = current
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
    let mut builder = state.ai_http.get(endpoint);
    if let Some(key) = api_key.as_deref() {
        builder = builder.bearer_auth(key);
    }
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
    let models = normalize_ai_models(&merge_ai_models(&current.models, &synced)?, &current.model)?;
    // 同步后仅保留仍存在的已选模型；当前 model 始终保留
    let enabled_models =
        normalize_enabled_ai_models(&models, &current.enabled_models, &current.model)?;
    let next = AiProviderConfigStore {
        version: AI_CONFIG_VERSION,
        base_url: current.base_url,
        model: current.model,
        models,
        enabled_models,
        use_api_key: current.use_api_key,
        api_key_secret_id: current.api_key_secret_id,
    };
    save_ai_config(&next)?;
    *state.ai_config.lock().await = next.clone();
    let revealed = api_key.as_ref().map(|key| key.as_str().to_string());
    Ok(ai_config_snapshot(&next, revealed, None))
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
    let endpoint = ai_chat_completions_url(&config.base_url)?;
    let api_key = if config.use_api_key {
        let secret_id = config
            .api_key_secret_id
            .as_deref()
            .ok_or_else(|| "尚未配置 AI API Key".to_string())?;
        let credentials = state.credentials.lock().await;
        Some(Zeroizing::new(resolve_credential(&credentials, secret_id)?))
    } else {
        None
    };

    let payload = OpenAiChatRequest {
        model: &config.model,
        messages: &request.messages,
    };
    let mut builder = state.ai_http.post(endpoint).json(&payload);
    if let Some(key) = api_key.as_deref() {
        builder = builder.bearer_auth(key);
    }
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
    let response: OpenAiChatResponse = serde_json::from_str(&body)
        .map_err(|error| format!("AI 供应商响应格式不兼容：{error}"))?;
    let content = response
        .choices
        .first()
        .and_then(|choice| extract_ai_content(&choice.message.content))
        .ok_or_else(|| "AI 供应商响应中没有可用文本".to_string())?;
    Ok(AiChatResponse {
        content,
        model: response.model.unwrap_or(config.model),
    })
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
        let chars = message.content.chars().count();
        if chars > 64_000 {
            return Err("单条 AI 会话消息不能超过 64000 个字符".to_string());
        }
        total_chars = total_chars.saturating_add(chars);
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
    let _ = app.emit(
        AI_CHAT_STREAM_EVENT,
        AiChatStreamEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            delta,
            model,
            message,
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

fn take_sse_events(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    loop {
        let separator = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|index| (index, 2))
            .or_else(|| {
                buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| (index, 4))
            });
        let Some((index, length)) = separator else {
            break;
        };
        let event = buffer.drain(..index).collect::<Vec<_>>();
        buffer.drain(..length);
        events.push(event);
    }
    events
}

fn sse_data(event: &[u8]) -> Result<Option<String>, String> {
    let text = std::str::from_utf8(event).map_err(|_| "AI 流式响应不是有效 UTF-8".to_string())?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    Ok((!data.is_empty()).then_some(data))
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
    let endpoint = ai_chat_completions_url(&config.base_url)?;
    let api_key = if config.use_api_key {
        let secret_id = config
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
    let payload = OpenAiChatStreamRequest {
        model: &config.model,
        messages: &request.messages,
        stream: true,
    };
    let mut builder = state.ai_http.post(endpoint).json(&payload);
    if let Some(key) = api_key.as_deref() {
        builder = builder.bearer_auth(key);
    }
    emit_ai_stream_event(
        &app,
        &request.request_id,
        "started",
        None,
        Some(config.model.clone()),
        None,
    );
    let send_result = tokio::select! {
        result = builder.send() => Some(result),
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
                Some(format!("AI 供应商请求失败：{error}")),
            );
            finish_ai_generation(&state, &request.request_id, &generation.signal).await;
            return Ok(());
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
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
    let mut response_model = config.model;
    let mut completed = false;
    let mut cancelled = false;
    let mut stream_error = None;
    'stream: loop {
        let chunk = tokio::select! {
            result = response.chunk() => Some(result),
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
                    emit_ai_stream_event(
                        &app,
                        &request.request_id,
                        "completed",
                        None,
                        Some(response_model.clone()),
                        None,
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
                    Some(format!("AI 流式响应读取失败：{error}")),
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
                emit_ai_stream_event(
                    &app,
                    &request.request_id,
                    "completed",
                    None,
                    Some(response_model.clone()),
                    None,
                );
                completed = true;
                break;
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
                if choice.finish_reason.is_some() && !completed {
                    emit_ai_stream_event(
                        &app,
                        &request.request_id,
                        "completed",
                        None,
                        Some(response_model.clone()),
                        None,
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

    // Each connect call creates a brand-new terminal instance.
    let terminal_id = Uuid::new_v4();
    let terminal_id_str = terminal_id.to_string();

    // Lock released here — connect_russh_session may take up to 15s.
    let handle = match connect_russh_session(&app, &terminal_id_str, &session).await {
        Ok(handle) => handle,
        Err(error) => {
            emit_remote_log(&app, &terminal_id_str, format!("FAILED {error}"));
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
            return Err(error);
        }
    };

    let closed = Arc::clone(&remote_session.closed);
    let close_notification = Arc::clone(&remote_session.close_notification);
    let cleanup_state = Arc::clone(state.inner());
    {
        let mut terminals = state.remote_terminals.lock().await;
        terminals.insert(terminal_id, remote_session);
    }
    tokio::spawn(async move {
        if !closed.load(Ordering::SeqCst) {
            close_notification.notified().await;
        }
        let removed = cleanup_state.remote_terminals.lock().await.remove(&terminal_id);
        if removed.is_some() {
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
    let ai_http = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(120))
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
        local_terminals: Mutex::new(HashMap::new()),
        remote_terminals: Mutex::new(HashMap::new()),
        transfer_handles: Mutex::new(HashMap::new()),
        transfer_cancellations: Mutex::new(HashMap::new()),
        local_sys_monitor: std::sync::Mutex::new(None),
    });

    tauri::Builder::default()
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
                    let hwnd = window.hwnd().unwrap().0;
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
            list_local_directory,
            read_local_file_preview,
            read_local_file_full,
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
            sync_ai_provider_models,
            ai_chat,
            ai_chat_stream,
            stop_ai_chat,
            list_ai_conversations,
            save_ai_conversation,
            delete_ai_conversation,
            run_ai_terminal_command,
            connect_session,
            disconnect_session,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PandaTerm");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_enumeration_includes_both_boundaries() {
        let letters: Vec<char> = windows_drive_letters().collect();
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
        assert!(validate_remote_upload_completion(None, true).is_ok());
        assert!(validate_remote_upload_completion(Some(0), true).is_ok());
        assert!(validate_remote_upload_completion(None, false).is_err());
        assert!(validate_remote_upload_completion(Some(1), true).is_err());
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
            "messages":[]
        }"#;
        let mut conversation: AiConversation =
            serde_json::from_str(legacy).expect("deserialize legacy conversation");
        assert_eq!(conversation.mode, "ask");
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
}
