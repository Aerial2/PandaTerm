#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use encoding_rs::GBK;
use panda_core::{TerminalEvent, TerminalEventKind};
use panda_session::{AuthType, ReconnectPolicy, Session, SessionCatalog};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, Notify, Semaphore};
use uuid::Uuid;

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

struct AppState {
    sessions: Mutex<SessionCatalog>,
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
    session: Session,
}

enum RemoteTerminalCommand {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Close,
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

/// Local obfuscation for secrets at rest (not a full KMS; better than plaintext JSON).
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

fn obfuscate_secret(plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(SECRET_PREFIX) {
        return plain.to_string();
    }
    let key = secret_obfuscation_key();
    let mut out = Vec::with_capacity(plain.len());
    for (i, b) in plain.as_bytes().iter().enumerate() {
        out.push(b ^ key[i % 32] ^ ((i as u8).wrapping_mul(31)));
    }
    format!("{SECRET_PREFIX}{}", base64_encode(&out))
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

fn protect_session_secrets(session: &mut Session, protect: bool) {
    match &mut session.auth {
        AuthType::Password { secret_id } => {
            *secret_id = if protect {
                obfuscate_secret(secret_id)
            } else {
                deobfuscate_secret(secret_id)
            };
        }
        AuthType::KeyboardInteractive {
            response_secret_id,
        } => {
            *response_secret_id = if protect {
                obfuscate_secret(response_secret_id)
            } else {
                deobfuscate_secret(response_secret_id)
            };
        }
        AuthType::PrivateKey {
            passphrase_secret_id,
            ..
        } => {
            if let Some(pass) = passphrase_secret_id.as_mut() {
                *pass = if protect {
                    obfuscate_secret(pass)
                } else {
                    deobfuscate_secret(pass)
                };
            }
        }
        AuthType::Agent | AuthType::Gssapi { .. } => {}
    }
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

fn load_persistent_sessions() -> Vec<Session> {
    let Ok(path) = session_store_path() else {
        return Vec::new();
    };

    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut sessions = serde_json::from_str::<Vec<Session>>(&content).unwrap_or_default();
    for session in &mut sessions {
        protect_session_secrets(session, false);
    }
    sessions
}

fn save_persistent_sessions(sessions: &[Session]) -> Result<(), String> {
    let path = session_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("连接配置目录创建失败：{error}"))?;
    }

    let protected: Vec<Session> = sessions
        .iter()
        .map(|session| {
            let mut clone = session.clone();
            protect_session_secrets(&mut clone, true);
            clone
        })
        .collect();

    let content = serde_json::to_string_pretty(&protected)
        .map_err(|error| format!("连接配置序列化失败：{error}"))?;
    fs::write(&path, content).map_err(|error| format!("连接配置保存失败：{error}"))
}

fn same_session_identity(left: &Session, right: &Session) -> bool {
    left.name.eq_ignore_ascii_case(&right.name)
        && left.host.eq_ignore_ascii_case(&right.host)
        && left.port == right.port
        && left.username.eq_ignore_ascii_case(&right.username)
}

fn load_initial_sessions() -> Vec<Session> {
    let mut sessions = load_persistent_sessions();

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
    sessions
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

    let session = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|remote| remote.session.clone())
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };
    let transfer_terminal_id = format!("{terminal_id}:transfer");
    match connect_russh_session(app, &transfer_terminal_id, &session).await {
        Ok(handle) => {
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
    session: Session,
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
        session,
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
    for index in 0..=10_000 {
        let candidate = local_destination_candidate(directory, file_name, index)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("写入本地文件失败：{error}"));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建本地文件失败：{error}")),
        }
    }
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
        "printf 'SIZE:%s\\n' \"$(stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null || echo 0)\"; \
         head -c {limit} {quoted} 2>/dev/null || dd if={quoted} bs={limit} count=1 2>/dev/null",
        limit = REMOTE_FILE_PREVIEW_LIMIT
    );
    let output = exec_remote_command(&handle, &command).await?;

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
    let size_output = exec_remote_command(
        &handle,
        &format!(
            "stat -c %s {quoted} 2>/dev/null || stat -f %z {quoted} 2>/dev/null || wc -c < {quoted} 2>/dev/null || echo 0"
        ),
    )
    .await?;
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

    let output = exec_remote_command(&handle, &format!("cat {quoted} 2>/dev/null")).await?;
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

#[tauri::command]
async fn write_local_file(path: String, content: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    fs::write(&file_path, content.as_bytes()).map_err(|error| error.to_string())
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

    if file_name.contains('/') || file_name.contains('\\') {
        return Err("远程文件名不能包含路径分隔符".to_string());
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
    let mut file_jobs: Vec<(PathBuf, String)> = Vec::new();

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
                file_jobs.push((entry_path, remote_entry_path));
            }
        }
    }

    // Bounded concurrency on one reused transfer connection.
    let concurrency = recommended_upload_concurrency(&state).max(1);
    let semaphore = std::sync::Arc::new(Semaphore::new(concurrency));
    let mut tasks = Vec::with_capacity(file_jobs.len());

    for (local_path, remote_entry_path) in file_jobs {
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
        tasks.push(task);
    }

    let mut files_uploaded: u64 = 0;
    for task in tasks {
        match task.await {
            Ok(Ok(())) => {
                files_uploaded += 1;
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
        let size_out = exec_remote_command(&handle, &format!("stat -c %s {quoted} 2>/dev/null || echo 0")).await?;
        let size: u64 = String::from_utf8_lossy(&size_out).trim().parse().unwrap_or(0);
        if size > DATA_URL_LIMIT {
            return Err(format!("文件过大（{} 字节），媒体查看上限 {} 字节", size, DATA_URL_LIMIT));
        }
        exec_remote_command(&handle, &format!("cat {quoted} 2>/dev/null")).await?
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

#[tauri::command]
async fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<Session>, String> {
    let sessions = state.sessions.lock().await;
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn save_session(
    session: Session,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
    let mut sessions = state.sessions.lock().await;
    sessions
        .upsert(session)
        .map_err(|error| error.to_string())?;
    save_persistent_sessions(sessions.all())?;
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn delete_session(
    session_id: Uuid,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
    let mut sessions = state.sessions.lock().await;
    sessions
        .remove(session_id)
        .map_err(|error| error.to_string())?;
    save_persistent_sessions(sessions.all())?;
    Ok(sessions.all().to_vec())
}

#[tauri::command]
async fn reorder_sessions(
    ordered_ids: Vec<Uuid>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Session>, String> {
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
    let remote_session = match spawn_russh_terminal(app.clone(), terminal_id_str.clone(), session.clone(), handle).await {
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
    let state = Arc::new(AppState {
        sessions: Mutex::new(SessionCatalog::new(load_initial_sessions())),
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
            connect_session,
            disconnect_session,
            terminal_write,
            terminal_resize,
            list_remote_directory,
            read_remote_file_preview,
            read_remote_file_full,
            write_local_file,
            write_remote_file,
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
