use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use encoding_rs::GBK;
use panda_core::{TerminalEvent, TerminalEventKind};
use panda_session::{AuthType, ReconnectPolicy, Session, SessionCatalog};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
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

struct AppState {
    sessions: Mutex<SessionCatalog>,
    local_terminals: Mutex<HashMap<Uuid, LocalTerminalSession>>,
    remote_terminals: Mutex<HashMap<Uuid, RemoteTerminalSession>>,
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
    handle: SharedRemoteHandle,
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

    sessions.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
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

fn load_persistent_sessions() -> Vec<Session> {
    let Ok(path) = session_store_path() else {
        return Vec::new();
    };

    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    serde_json::from_str::<Vec<Session>>(&content).unwrap_or_default()
}

fn save_persistent_sessions(sessions: &[Session]) -> Result<(), String> {
    let path = session_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("连接配置目录创建失败：{error}"))?;
    }

    let content = serde_json::to_string_pretty(sessions)
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

    sessions.sort_by(|left, right| {
        left.group
            .to_lowercase()
            .cmp(&right.group.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
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
        return normalize_shell_text(text.into_owned());
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
        return text.into_owned();
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

struct SshHandler;

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
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

    let config = Arc::new(russh::client::Config::default());
    let handler = SshHandler;

    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, (session.host.as_str(), session.port), handler),
    )
    .await
    .map_err(|_| format!("SSH 连接超时（15s）：{}", session.host))?
    .map_err(|error| format!("SSH 连接失败：{error}"))?;

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

async fn spawn_russh_terminal(
    app: AppHandle,
    terminal_id: String,
    _session: Session,
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
        let _ = channel.eof().await;
        let _ = channel.close().await;
        emit_terminal_output(&app, terminal_id_clone, "\r\n连接已关闭\r\n".to_string());
        drop(task_handle);
    });

    Ok(RemoteTerminalSession {
        control: tx,
        closed,
        handle: shared_handle,
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
) -> Result<(Vec<u8>, Vec<u8>, i32), String> {
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
    let mut exit_code: i32 = 0;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => stdout.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => stderr.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = exit_status as i32;
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

    let desktop = home.join("Desktop");
    if desktop.is_dir() {
        return Ok(desktop);
    }

    Ok(home)
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

    Ok(LocalDirectoryListing {
        path: format_path(canonical_directory.clone()),
        parent: canonical_directory
            .parent()
            .map(|parent| format_path(parent.to_path_buf())),
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
    let bytes = fs::read(&canonical_file).map_err(|error| error.to_string())?;
    let preview_bytes = &bytes[..read_size.min(bytes.len())];
    let content = String::from_utf8(preview_bytes.to_vec())
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
    // Resolve the canonical path, compute its parent, then list immediate
    // children with type/size/mtime via GNU find's printf.
    let command = format!(
        "__p=$(cd {quoted} 2>/dev/null && pwd) || __p={quoted}; \
         printf 'P:%s\\n' \"$__p\"; \
         __d=$(dirname \"$__p\"); [ \"$__d\" = \"$__p\" ] && __d=''; \
         printf 'D:%s\\n' \"$__d\"; \
         find \"$__p\" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null"
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
        "printf 'SIZE:%s\\n' \"$(stat -c %s {quoted} 2>/dev/null || echo 0)\"; \
         head -c {limit} {quoted} 2>/dev/null",
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
    let size_output = exec_remote_command(&handle, &format!("stat -c %s {quoted} 2>/dev/null || echo 0")).await?;
    let size_str = String::from_utf8_lossy(&size_output);
    let size: u64 = size_str.trim().parse().unwrap_or(0);
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

/// Write full file content to a remote path by piping data through `cat > path`
/// on a fresh exec channel — no base64 / escaping needed.
/// Emits "upload-progress" events with { transfer_id, transferred, total }.
///
/// 写入循环与等待退出发在同一个任务里。russh 的 `data()` 在窗口满时会 await，
/// 窗口调整帧由底层连接的后台事件循环自动处理，无需用户侧 `wait()` 驱动。
/// 写完所有 chunk 后发 EOF，再循环 `wait()` 等待远端 `cat` 退出。
async fn write_remote_file_content(
    handle: &russh::client::Handle<SshHandler>,
    path: &str,
    content: &[u8],
    app: &AppHandle,
    transfer_id: &str,
) -> Result<(), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    let quoted = shell_quote(path);
    channel
        .exec(true, format!("cat > {quoted}"))
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;
    // Write in chunks to respect channel window limits.
    let total = content.len();
    let mut transferred: usize = 0;
    for chunk in content.chunks(32768) {
        channel
            .data(chunk)
            .await
            .map_err(|error| format!("SSH 数据写入失败：{error}"))?;
        transferred += chunk.len();
        let _ = app.emit("upload-progress", serde_json::json!({
            "transfer_id": transfer_id,
            "transferred": transferred,
            "total": total,
        }));
    }
    channel
        .eof()
        .await
        .map_err(|error| format!("SSH eof 失败：{error}"))?;
    // Wait for the remote command to finish — must see ExitStatus and Close
    // to ensure all data was written to disk.
    let mut exit_code: i32 = 0;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = exit_status as i32;
            }
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.close().await;
    if exit_code != 0 {
        return Err(format!("远程写入失败，退出码: {exit_code}"));
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
    let handle = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };
    // No progress tracking for editor saves — use a dummy transfer_id.
    write_remote_file_content(&handle, &path, content.as_bytes(), &app, "editor-save").await
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
    // Decode base64 content.
    let content = base64_decode(&content_base64)
        .map_err(|e| format!("Base64 解码失败：{e}"))?;

    // Build destination path.
    let dest_path = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };

    if let Some(tid) = terminal_id {
        // Remote upload: write via SSH exec channel.
        let handle = {
            let terminals = state.remote_terminals.lock().await;
            terminals
                .get(&tid)
                .map(|session| Arc::clone(&session.handle))
                .ok_or_else(|| format!("terminal is not connected: {tid}"))?
        };
        write_remote_file_content(&handle, &dest_path, &content, &app, &transfer_id).await?;
        // Verify file size matches to catch truncated uploads.
        let quoted = shell_quote(&dest_path);
        let (size_out, _, _) = exec_remote_command_full(&handle, &format!("stat -c %s {quoted} 2>/dev/null || echo 0")).await?;
        let remote_size: u64 = String::from_utf8_lossy(&size_out).trim().parse().unwrap_or(0);
        if remote_size != content.len() as u64 {
            return Err(format!(
                "上传校验失败：本地 {} 字节，远程 {} 字节",
                content.len(),
                remote_size
            ));
        }
    } else {
        // Local upload: write bytes directly.
        let dest = PathBuf::from(&dest_path);
        fs::write(&dest, &content).map_err(|error| format!("写入本地文件失败：{error}"))?;
    }

    Ok(dest_path)
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
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let handle = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };

    let local = PathBuf::from(&local_path);
    let file_name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "无法解析文件名".to_string())?;

    let metadata = tokio::fs::metadata(&local)
        .await
        .map_err(|e| format!("读取文件信息失败：{e}"))?;
    let total = metadata.len() as usize;

    let dest_path = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };

    // Open a fresh exec channel and pipe file content through `cat > path`.
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 通道创建失败：{error}"))?;
    let quoted = shell_quote(&dest_path);
    channel
        .exec(true, format!("cat > {quoted}"))
        .await
        .map_err(|error| format!("SSH exec 失败：{error}"))?;

    // Read the file in chunks and write each chunk to the SSH channel.
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(&local)
        .await
        .map_err(|e| format!("打开本地文件失败：{e}"))?;

    let chunk_size: usize = 32768;
    let mut buffer = vec![0u8; chunk_size];
    let mut transferred: usize = 0;

    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取本地文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        channel
            .data(&buffer[..n])
            .await
            .map_err(|error| format!("SSH 数据写入失败：{error}"))?;
        transferred += n;
        let _ = app.emit(
            "upload-progress",
            serde_json::json!({
                "transfer_id": transfer_id,
                "transferred": transferred,
                "total": total,
            }),
        );
    }

    drop(file);

    channel
        .eof()
        .await
        .map_err(|error| format!("SSH eof 失败：{error}"))?;

    let mut exit_code: i32 = 0;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = exit_status as i32;
            }
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.close().await;
    if exit_code != 0 {
        return Err(format!("远程写入失败，退出码: {exit_code}"));
    }

    // Verify file size matches to catch truncated uploads.
    let quoted = shell_quote(&dest_path);
    let (size_out, _, _) = exec_remote_command_full(
        &handle,
        &format!("stat -c %s {quoted} 2>/dev/null || echo 0"),
    )
    .await?;
    let remote_size: u64 = String::from_utf8_lossy(&size_out)
        .trim()
        .parse()
        .unwrap_or(0);
    if remote_size != total as u64 {
        return Err(format!(
            "上传校验失败：本地 {total} 字节，远程 {remote_size} 字节"
        ));
    }

    Ok(dest_path)
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
        if code != 0 {
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
        if code != 0 {
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
        if code != 0 {
            return Err(format!("创建目录失败: {}", String::from_utf8_lossy(&stderr)));
        }
    } else {
        fs::create_dir_all(&path).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    Ok(())
}

/// Copy a file or directory into a destination directory.
#[tauri::command]
async fn copy_path(
    terminal_id: Option<Uuid>,
    source: String,
    dest_dir: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let file_name = source.rsplit('/').next().unwrap_or(&source);
    let dest = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };

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
        if code != 0 {
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
#[tauri::command]
async fn move_path(
    terminal_id: Option<Uuid>,
    source: String,
    dest_dir: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let file_name = source.rsplit('/').next().unwrap_or(&source);
    let dest = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };

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
        if code != 0 {
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
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
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
    if filtered.len() % 4 != 0 {
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
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.len() > DATA_URL_LIMIT {
            return Err(format!("文件过大（{} 字节），媒体查看上限 {} 字节", meta.len(), DATA_URL_LIMIT));
        }
        fs::read(&p).map_err(|e| e.to_string())?
    };

    let encoded = base64_encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Download a remote file to a local directory.
#[tauri::command]
async fn download_remote_file(
    terminal_id: Uuid,
    remote_path: String,
    local_dir: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let handle = {
        let terminals = state.remote_terminals.lock().await;
        terminals
            .get(&terminal_id)
            .map(|session| Arc::clone(&session.handle))
            .ok_or_else(|| format!("terminal is not connected: {terminal_id}"))?
    };

    let quoted = shell_quote(&remote_path);
    let bytes = exec_remote_command(&handle, &format!("cat {quoted} 2>/dev/null")).await?;

    let file_name = remote_path.rsplit('/').next().unwrap_or("download");
    let local_path = PathBuf::from(&local_dir).join(file_name);
    fs::write(&local_path, &bytes)
        .map_err(|e| format!("写入本地文件失败：{e}"))?;
    Ok(local_path.to_string_lossy().to_string())
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
        if exit_code != 0 {
            let detail = if !stderr.is_empty() {
                String::from_utf8_lossy(&stderr).to_string()
            } else if !stdout.is_empty() {
                String::from_utf8_lossy(&stdout).to_string()
            } else {
                format!("退出码: {exit_code}")
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
        if exit_code != 0 {
            let detail = if !stderr.is_empty() {
                String::from_utf8_lossy(&stderr).to_string()
            } else {
                format!("退出码: {exit_code}")
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

    // Insert under the new terminal_id.
    let mut terminals = state.remote_terminals.lock().await;
    terminals.insert(terminal_id, remote_session);

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
    let mut terminals = state.remote_terminals.lock().await;
    if let Some(session) = terminals.remove(&terminal_id) {
        session.closed.store(true, Ordering::SeqCst);
        let _ = session.control.send(RemoteTerminalCommand::Close).await;
    }

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
    let mut terminals = state.remote_terminals.lock().await;
    let session = terminals
        .get_mut(&request.terminal_id)
        .ok_or_else(|| format!("terminal is not connected: {}", request.terminal_id))?;

    session
        .control
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
    let mut terminals = state.remote_terminals.lock().await;
    let session = terminals
        .get_mut(&request.terminal_id)
        .ok_or_else(|| format!("terminal is not connected: {}", request.terminal_id))?;

    session
        .control
        .send(RemoteTerminalCommand::Resize {
            cols: request.cols.max(1),
            rows: request.rows.max(1),
        })
        .await
        .map_err(|error| format!("terminal resize failed: {error}"))?;

    Ok(())
}

fn main() {
    let state = Arc::new(AppState {
        sessions: Mutex::new(SessionCatalog::new(load_initial_sessions())),
        local_terminals: Mutex::new(HashMap::new()),
        remote_terminals: Mutex::new(HashMap::new()),
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PandaTerm");
}
