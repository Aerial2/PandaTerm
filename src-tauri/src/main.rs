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

struct RemoteTerminalSession {
    control: mpsc::Sender<RemoteTerminalCommand>,
    closed: Arc<AtomicBool>,
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
        drop(handle);
    });

    Ok(RemoteTerminalSession {
        control: tx,
        closed,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PandaTerm");
}
