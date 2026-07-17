//! Model Context Protocol (MCP) client for PandaTerm.
//!
//! Cursor-compatible config shape under `~/.pandaterm/mcp.json`.
//! Runtime: stdio (newline-delimited JSON-RPC) and streamable-http (JSON / SSE responses).
//! Legacy Content-Length framing is still accepted on read for older servers.
//! Legacy pure SSE (GET event stream) is not implemented; URL transports use streamable-http client.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

pub const MCP_CONFIG_VERSION: u8 = 1;
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const MCP_HTTP_PROTOCOL_VERSION: &str = "2025-03-26";
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// uvx/npx 首次拉包可能较慢，initialize 给更宽裕窗口
const MCP_INIT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MCP_SERVERS: usize = 40;
const MAX_MCP_TOOLS: usize = 200;
const MAX_ENV_ENTRIES: usize = 64;
const MAX_ARGS: usize = 64;
const MAX_HEADERS: usize = 32;
const MAX_CALL_RESULT_CHARS: usize = 64_000;

// ── Config ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Sse,
    #[serde(rename = "streamable-http")]
    StreamableHttp,
}

impl Default for McpTransport {
    fn default() -> Self {
        Self::Stdio
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Unique id; also used as display name when `name` is empty.
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub transport: McpTransport,
    /// stdio
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// sse / streamable-http
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Cursor uses `disabled`; we store inverted `enabled` for UI clarity.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl McpServerConfig {
    pub fn display_name(&self) -> &str {
        let name = self.name.trim();
        if !name.is_empty() {
            name
        } else {
            self.id.as_str()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpConfigStore {
    pub version: u8,
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

impl Default for McpConfigStore {
    fn default() -> Self {
        Self {
            version: MCP_CONFIG_VERSION,
            servers: Vec::new(),
        }
    }
}

/// Cursor `mcp.json` import shape: `{ "mcpServers": { "name": { ... } } }`
#[derive(Debug, Deserialize)]
struct CursorMcpFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: HashMap<String, CursorMcpServer>,
}

#[derive(Debug, Deserialize)]
struct CursorMcpServer {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(default)]
    transport: Option<String>,
}

// ── Snapshots for frontend ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerSnapshot {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
    /// disabled | connecting | connected | error
    pub status: String,
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
    pub tool_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpConfigSnapshot {
    pub servers: Vec<McpServerSnapshot>,
    pub error: Option<String>,
    /// 落盘路径，便于设置页展示
    #[serde(default)]
    pub config_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveMcpConfigRequest {
    pub servers: Vec<McpServerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CallMcpToolRequest {
    pub server_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallMcpToolResult {
    pub content: String,
    pub is_error: bool,
}

/// 可导入的外部 MCP 配置候选（Cursor 全局等）
#[derive(Debug, Clone, Serialize)]
pub struct McpImportCandidate {
    pub id: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
    pub server_count: Option<usize>,
    pub error: Option<String>,
}

/// 从路径导入后的预览（不落盘；由前端合并到草稿）
#[derive(Debug, Clone, Serialize)]
pub struct McpImportPreview {
    pub path: String,
    pub servers: Vec<McpServerConfig>,
    pub server_count: usize,
}

// ── Runtime ─────────────────────────────────────────────────────────────

struct PendingRequest {
    response_tx: oneshot::Sender<Result<Value, String>>,
}

struct LiveStdioSession {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<AtomicU64>,
    tools: Vec<McpToolInfo>,
}

/// Streamable HTTP MCP session（SSE 旧传输未单独实现；URL 类统一走此客户端）
struct LiveHttpSession {
    client: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    session_id: Option<String>,
    next_id: AtomicU64,
    tools: Vec<McpToolInfo>,
}

enum LiveSession {
    Stdio(LiveStdioSession),
    Http(LiveHttpSession),
}

impl LiveSession {
    async fn shutdown(self) {
        if let LiveSession::Stdio(mut live) = self {
            let _ = live.child.kill().await;
        }
    }
}

struct SessionSlot {
    status: String,
    error: Option<String>,
    tools: Vec<McpToolInfo>,
    live: Option<LiveSession>,
}

impl Default for SessionSlot {
    fn default() -> Self {
        Self {
            status: "disabled".to_string(),
            error: None,
            tools: Vec::new(),
            live: None,
        }
    }
}

pub struct McpRuntime {
    sessions: Mutex<HashMap<String, SessionSlot>>,
    /// Shared stdout reader tasks need to route responses.
    response_routes: Mutex<HashMap<String, Arc<Mutex<HashMap<u64, PendingRequest>>>>>,
    http: reqwest::Client,
}

impl Default for McpRuntime {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(MCP_REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            sessions: Mutex::new(HashMap::new()),
            response_routes: Mutex::new(HashMap::new()),
            http,
        }
    }
}

// ── Path / load / save ──────────────────────────────────────────────────

pub fn mcp_config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp.json")
}

/// 解析 MCP 配置正文：优先 PandaTerm store 形态，再回退 Cursor `{ "mcpServers": … }`。
pub fn parse_mcp_config_content(content: &str) -> Result<McpConfigStore, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(McpConfigStore::default());
    }
    if let Ok(mut store) = serde_json::from_str::<McpConfigStore>(trimmed) {
        if store.version != MCP_CONFIG_VERSION {
            return Err(format!("不支持的 MCP 配置版本：{}", store.version));
        }
        store.servers = normalize_mcp_servers(store.servers)?;
        return Ok(store);
    }
    if let Ok(cursor) = serde_json::from_str::<CursorMcpFile>(trimmed) {
        let servers = cursor
            .mcp_servers
            .into_iter()
            .map(|(id, entry)| cursor_server_to_config(id, entry))
            .collect::<Vec<_>>();
        let servers = normalize_mcp_servers(servers)?;
        return Ok(McpConfigStore {
            version: MCP_CONFIG_VERSION,
            servers,
        });
    }
    Err("无法识别的 MCP 配置（需要 PandaTerm store 或 Cursor mcpServers）".to_string())
}

pub fn load_mcp_config(path: &Path) -> Result<McpConfigStore, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(McpConfigStore::default());
        }
        Err(error) => return Err(format!("MCP 配置读取失败：{error}")),
    };
    parse_mcp_config_content(&content).map_err(|error| {
        if error.contains("无法识别") {
            "MCP 配置已损坏，已拒绝覆盖原文件".to_string()
        } else {
            error
        }
    })
}

pub fn save_mcp_config(path: &Path, store: &McpConfigStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(store)
        .map_err(|error| format!("MCP 配置序列化失败：{error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法定位 MCP 配置目录：{}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("MCP 配置目录创建失败：{error}"))?;
    let temporary = parent.join(format!(".mcp.json.{}.tmp", Uuid::new_v4()));
    let write_result = (|| {
        std::fs::write(&temporary, content.as_bytes())
            .map_err(|error| format!("MCP 临时文件写入失败：{error}"))?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let source_wide = temporary
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let destination_wide = path
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
                return Err(format!(
                    "MCP 配置原子替换失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            std::fs::rename(&temporary, path)
                .map_err(|error| format!("MCP 配置原子替换失败：{error}"))
        }
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

fn cursor_server_to_config(id: String, entry: CursorMcpServer) -> McpServerConfig {
    let url = entry.url.unwrap_or_default();
    let transport = match entry.transport.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("sse") => McpTransport::Sse,
        Some("streamable-http") | Some("http") => McpTransport::StreamableHttp,
        Some("stdio") => McpTransport::Stdio,
        // 有 URL 默认 streamable-http（运行时可连）；显式 transport=sse 仍保留标签
        _ if !url.trim().is_empty() => McpTransport::StreamableHttp,
        _ => McpTransport::Stdio,
    };
    McpServerConfig {
        id: id.clone(),
        name: id,
        transport,
        command: entry.command.unwrap_or_default(),
        args: entry.args.unwrap_or_default(),
        env: entry.env.unwrap_or_default(),
        cwd: entry.cwd,
        url,
        headers: entry.headers.unwrap_or_default(),
        enabled: !entry.disabled.unwrap_or(false),
    }
}

pub fn normalize_mcp_servers(servers: Vec<McpServerConfig>) -> Result<Vec<McpServerConfig>, String> {
    if servers.len() > MAX_MCP_SERVERS {
        return Err(format!("最多配置 {MAX_MCP_SERVERS} 个 MCP 服务器"));
    }
    let mut seen = HashMap::new();
    let mut normalized = Vec::with_capacity(servers.len());
    for server in servers {
        let id = validate_mcp_server_id(&server.id)?;
        if seen.insert(id.clone(), ()).is_some() {
            return Err(format!("MCP 服务器 id 重复：{id}"));
        }
        let name = server.name.trim().to_string();
        let transport = server.transport;
        let enabled = server.enabled;
        match transport {
            McpTransport::Stdio => {
                let command = server.command.trim().to_string();
                // 禁用态允许空 command，方便 Cursor 风格“先添加再填写”
                if command.is_empty() && enabled {
                    return Err(format!("stdio MCP「{id}」缺少 command"));
                }
                if command.chars().count() > 512 {
                    return Err(format!("stdio MCP「{id}」command 过长"));
                }
                if server.args.len() > MAX_ARGS {
                    return Err(format!("stdio MCP「{id}」参数过多"));
                }
                for arg in &server.args {
                    if arg.chars().count() > 2_048 {
                        return Err(format!("stdio MCP「{id}」参数过长"));
                    }
                }
                if server.env.len() > MAX_ENV_ENTRIES {
                    return Err(format!("stdio MCP「{id}」环境变量过多"));
                }
                for (key, value) in &server.env {
                    if key.trim().is_empty() || key.chars().count() > 128 {
                        return Err(format!("stdio MCP「{id}」环境变量名无效"));
                    }
                    if value.chars().count() > 4_096 {
                        return Err(format!("stdio MCP「{id}」环境变量值过长"));
                    }
                }
                if let Some(cwd) = server.cwd.as_ref() {
                    if cwd.chars().count() > 1_024 {
                        return Err(format!("stdio MCP「{id}」cwd 过长"));
                    }
                }
                normalized.push(McpServerConfig {
                    id,
                    name,
                    transport,
                    command,
                    args: server.args,
                    env: server.env,
                    cwd: server.cwd.filter(|value| !value.trim().is_empty()),
                    url: String::new(),
                    headers: HashMap::new(),
                    enabled,
                });
            }
            McpTransport::Sse | McpTransport::StreamableHttp => {
                let url = server.url.trim().to_string();
                if url.is_empty() && enabled {
                    return Err(format!("远程 MCP「{id}」缺少 url"));
                }
                if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(format!("远程 MCP「{id}」url 必须以 http(s):// 开头"));
                }
                if url.chars().count() > 2_048 {
                    return Err(format!("远程 MCP「{id}」url 过长"));
                }
                if server.headers.len() > MAX_HEADERS {
                    return Err(format!("远程 MCP「{id}」headers 过多"));
                }
                for (key, value) in &server.headers {
                    if key.trim().is_empty() || key.chars().count() > 128 {
                        return Err(format!("远程 MCP「{id}」header 名无效"));
                    }
                    if value.chars().count() > 4_096 {
                        return Err(format!("远程 MCP「{id}」header 值过长"));
                    }
                }
                normalized.push(McpServerConfig {
                    id,
                    name,
                    transport,
                    command: String::new(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    cwd: None,
                    url,
                    headers: server.headers,
                    enabled,
                });
            }
        }
    }
    Ok(normalized)
}

fn validate_mcp_server_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty() || id.chars().count() > 64 {
        return Err("MCP 服务器 id 必须为 1 到 64 个字符".to_string());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("MCP 服务器 id 仅允许字母、数字、.-_".to_string());
    }
    Ok(id.to_string())
}

/// 常见 Cursor / Claude Desktop 全局 MCP 配置路径（仅探测，不写文件）。
pub fn list_mcp_import_candidates() -> Vec<McpImportCandidate> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push = |id: &str, label: &str, path: PathBuf| {
        let path_str = path.to_string_lossy().into_owned();
        if !seen.insert(path_str.clone()) {
            return;
        }
        let (exists, server_count, error) = if path.is_file() {
            match std::fs::read_to_string(&path)
                .map_err(|e| format!("读取失败：{e}"))
                .and_then(|content| parse_mcp_config_content(&content))
            {
                Ok(store) => (true, Some(store.servers.len()), None),
                Err(err) => (true, None, Some(err)),
            }
        } else {
            (false, None, None)
        };
        candidates.push(McpImportCandidate {
            id: id.to_string(),
            label: label.to_string(),
            path: path_str,
            exists,
            server_count,
            error,
        });
    };

    // 当前工作目录向上查找项目级 .cursor/mcp.json
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd.as_path());
        let mut depth = 0usize;
        while let Some(current) = dir {
            if depth >= 6 {
                break;
            }
            let project_path = current.join(".cursor").join("mcp.json");
            push(
                &format!("project-cursor-{depth}"),
                &format!("项目 .cursor/mcp.json ({})", current.display()),
                project_path,
            );
            dir = current.parent();
            depth += 1;
        }
    }

    if let Some(home) = dirs_home_dir() {
        push(
            "cursor-global",
            "Cursor 全局 (~/.cursor/mcp.json)",
            home.join(".cursor").join("mcp.json"),
        );
        push(
            "claude-desktop",
            "Claude Desktop",
            home
                .join("AppData")
                .join("Roaming")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
        // macOS Claude Desktop
        push(
            "claude-desktop-macos",
            "Claude Desktop (macOS)",
            home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
        // Linux Claude
        push(
            "claude-desktop-linux",
            "Claude Desktop (Linux)",
            home
                .join(".config")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = PathBuf::from(appdata);
        push(
            "cursor-appdata",
            "Cursor AppData",
            appdata.join("Cursor").join("User").join("globalStorage").join("mcp.json"),
        );
        push(
            "claude-desktop-appdata",
            "Claude Desktop (APPDATA)",
            appdata.join("Claude").join("claude_desktop_config.json"),
        );
    }

    // 存在的候选排前，便于 UI 优先展示
    candidates.sort_by(|left, right| {
        right
            .exists
            .cmp(&left.exists)
            .then_with(|| left.label.cmp(&right.label))
    });

    candidates
}

fn dirs_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 从任意路径读取并解析 MCP 服务器列表（Cursor / PandaTerm / Claude desktop 形态）。
pub fn import_mcp_servers_from_path(path: &str) -> Result<McpImportPreview, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("导入路径不能为空".to_string());
    }
    if path.chars().count() > 1_024 {
        return Err("导入路径过长".to_string());
    }
    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let content = std::fs::read_to_string(&path_buf)
        .map_err(|error| format!("MCP 配置读取失败：{error}"))?;
    // Claude Desktop 使用 mcpServers 字段，与 Cursor 相同；也兼容我们的 store。
    let store = parse_mcp_config_content(&content)?;
    if store.servers.is_empty() {
        return Err("该文件中没有可导入的 MCP 服务器".to_string());
    }
    Ok(McpImportPreview {
        path: path_buf.to_string_lossy().into_owned(),
        server_count: store.servers.len(),
        servers: store.servers,
    })
}

/// 导出为 Cursor `{ "mcpServers": { ... } }` JSON 文本（不落盘）。
pub fn export_mcp_servers_cursor_json(servers: &[McpServerConfig]) -> Result<String, String> {
    let normalized = normalize_mcp_servers(servers.to_vec())?;
    let mut map = Map::new();
    for server in normalized {
        let mut entry = Map::new();
        match server.transport {
            McpTransport::Stdio => {
                entry.insert("command".into(), json!(server.command));
                if !server.args.is_empty() {
                    entry.insert("args".into(), json!(server.args));
                }
                if !server.env.is_empty() {
                    entry.insert("env".into(), json!(server.env));
                }
                if let Some(cwd) = server.cwd.as_ref().filter(|value| !value.trim().is_empty()) {
                    entry.insert("cwd".into(), json!(cwd));
                }
            }
            McpTransport::Sse | McpTransport::StreamableHttp => {
                entry.insert("url".into(), json!(server.url));
                if !server.headers.is_empty() {
                    entry.insert("headers".into(), json!(server.headers));
                }
                entry.insert(
                    "transport".into(),
                    json!(transport_label(&server.transport)),
                );
            }
        }
        if !server.enabled {
            entry.insert("disabled".into(), json!(true));
        }
        // name 与 id 不同时写入，便于往返
        let display = server.name.trim();
        if !display.is_empty() && display != server.id {
            entry.insert("name".into(), json!(display));
        }
        map.insert(server.id, Value::Object(entry));
    }
    let root = json!({ "mcpServers": Value::Object(map) });
    serde_json::to_string_pretty(&root).map_err(|error| format!("MCP 导出序列化失败：{error}"))
}

/// 合并导入服务器到现有列表。
/// `overwrite=true`：同 id 覆盖；`false`：同 id 跳过。
pub fn merge_mcp_server_imports(
    existing: Vec<McpServerConfig>,
    imported: Vec<McpServerConfig>,
) -> Result<(Vec<McpServerConfig>, usize, usize), String> {
    merge_mcp_server_imports_with_strategy(existing, imported, true)
}

pub fn merge_mcp_server_imports_with_strategy(
    existing: Vec<McpServerConfig>,
    imported: Vec<McpServerConfig>,
    overwrite: bool,
) -> Result<(Vec<McpServerConfig>, usize, usize), String> {
    if imported.is_empty() {
        return Ok((existing, 0, 0));
    }
    let mut by_id: HashMap<String, McpServerConfig> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for server in existing {
        if !by_id.contains_key(&server.id) {
            order.push(server.id.clone());
        }
        by_id.insert(server.id.clone(), server);
    }
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    for server in imported {
        if by_id.contains_key(&server.id) {
            if overwrite {
                updated += 1;
                by_id.insert(server.id.clone(), server);
            } else {
                skipped = skipped.saturating_add(1);
            }
        } else {
            added += 1;
            order.push(server.id.clone());
            by_id.insert(server.id.clone(), server);
        }
    }
    let _ = skipped;
    let merged = order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect::<Vec<_>>();
    let normalized = normalize_mcp_servers(merged)?;
    Ok((normalized, added, updated))
}

pub fn transport_label(transport: &McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Sse => "sse",
        McpTransport::StreamableHttp => "streamable-http",
    }
}

fn snapshot_server(
    config: &McpServerConfig,
    slot: Option<&SessionSlot>,
) -> McpServerSnapshot {
    let (status, error, tools) = if !config.enabled {
        ("disabled".to_string(), None, Vec::new())
    } else if let Some(slot) = slot {
        (slot.status.clone(), slot.error.clone(), slot.tools.clone())
    } else {
        ("disconnected".to_string(), None, Vec::new())
    };
    let tool_count = tools.len();
    McpServerSnapshot {
        id: config.id.clone(),
        name: config.display_name().to_string(),
        transport: transport_label(&config.transport).to_string(),
        command: config.command.clone(),
        args: config.args.clone(),
        env: config.env.clone(),
        cwd: config.cwd.clone(),
        url: config.url.clone(),
        headers: config.headers.clone(),
        enabled: config.enabled,
        status,
        error,
        tools,
        tool_count,
    }
}

// ── Framing ─────────────────────────────────────────────────────────────
//
// MCP stdio transport（现行规范）：每条消息为单行 JSON-RPC，以 `\n` 分隔，消息体内禁止换行。
// 写入统一使用 NDJSON；读取同时兼容少数旧实现的 Content-Length 帧。

fn encode_mcp_message(body: &Value) -> Result<Vec<u8>, String> {
    let mut json = serde_json::to_vec(body).map_err(|error| format!("MCP 请求序列化失败：{error}"))?;
    // 规范要求消息不得嵌入换行；serde 默认紧凑序列化已满足
    if json.iter().any(|b| *b == b'\n' || *b == b'\r') {
        return Err("MCP 请求 JSON 含非法换行".to_string());
    }
    json.push(b'\n');
    Ok(json)
}

async fn read_mcp_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("MCP 响应读取失败：{error}"))?;
        if n == 0 {
            return Err("MCP 进程已退出".to_string());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        // 兼容旧 Content-Length 帧（LSP 风格）
        if let Some(rest) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            let length = rest
                .trim()
                .parse::<usize>()
                .map_err(|_| "MCP Content-Length 无效".to_string())?;
            // 读完剩余 header 直到空行
            loop {
                let mut header_line = String::new();
                let hn = reader
                    .read_line(&mut header_line)
                    .await
                    .map_err(|error| format!("MCP 响应读取失败：{error}"))?;
                if hn == 0 {
                    return Err("MCP 进程已退出".to_string());
                }
                if header_line.trim_end_matches(['\r', '\n']).is_empty() {
                    break;
                }
            }
            if length > 8 * 1024 * 1024 {
                return Err("MCP 响应体过大".to_string());
            }
            let mut body = vec![0u8; length];
            reader
                .read_exact(&mut body)
                .await
                .map_err(|error| format!("MCP 响应体读取失败：{error}"))?;
            return serde_json::from_slice(&body)
                .map_err(|error| format!("MCP 响应 JSON 无效：{error}"));
        }

        // 现行 NDJSON：整行即一条 JSON-RPC 消息
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => return Ok(value),
            Err(_) => {
                // 个别服务器会把日志误打到 stdout，跳过非 JSON 行
                eprintln!("[MCP] skip non-json stdio line: {}", trimmed.chars().take(200).collect::<String>());
                continue;
            }
        }
    }
}

// ── Runtime ops ─────────────────────────────────────────────────────────

impl McpRuntime {
    #[allow(dead_code)]
    pub async fn disconnect_all(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, slot) in sessions.drain() {
            if let Some(live) = slot.live {
                live.shutdown().await;
            }
        }
        self.response_routes.lock().await.clear();
    }

    pub async fn disconnect_server(&self, server_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(slot) = sessions.remove(server_id) {
            if let Some(live) = slot.live {
                live.shutdown().await;
            }
        }
        self.response_routes.lock().await.remove(server_id);
    }

    pub async fn snapshot(
        &self,
        store: &McpConfigStore,
        load_error: Option<String>,
        config_path: String,
    ) -> McpConfigSnapshot {
        let sessions = self.sessions.lock().await;
        let servers = store
            .servers
            .iter()
            .map(|server| snapshot_server(server, sessions.get(&server.id)))
            .collect();
        McpConfigSnapshot {
            servers,
            error: load_error,
            config_path,
        }
    }

    pub async fn sync_enabled_servers(&self, store: &McpConfigStore) {
        let enabled_ids: Vec<String> = store
            .servers
            .iter()
            .filter(|server| server.enabled)
            .map(|server| server.id.clone())
            .collect();
        {
            let mut sessions = self.sessions.lock().await;
            let stale: Vec<String> = sessions
                .keys()
                .filter(|id| !enabled_ids.iter().any(|enabled| enabled == *id))
                .cloned()
                .collect();
            for id in stale {
                if let Some(slot) = sessions.remove(&id) {
                    if let Some(live) = slot.live {
                        live.shutdown().await;
                    }
                }
                self.response_routes.lock().await.remove(&id);
            }
        }
        for server in store.servers.iter().filter(|server| server.enabled) {
            let needs_connect = {
                let sessions = self.sessions.lock().await;
                match sessions.get(&server.id) {
                    Some(slot) if slot.status == "connected" && slot.live.is_some() => false,
                    _ => true,
                }
            };
            if needs_connect {
                let _ = self.connect_server(server).await;
            }
        }
    }

    pub async fn connect_server(&self, config: &McpServerConfig) -> Result<McpServerSnapshot, String> {
        self.disconnect_server(&config.id).await;
        if !config.enabled {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                config.id.clone(),
                SessionSlot {
                    status: "disabled".to_string(),
                    ..SessionSlot::default()
                },
            );
            return Ok(snapshot_server(config, sessions.get(&config.id)));
        }
        if matches!(config.transport, McpTransport::Stdio) && config.command.trim().is_empty() {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                config.id.clone(),
                SessionSlot {
                    status: "error".to_string(),
                    error: Some("stdio MCP 缺少 command".to_string()),
                    tools: Vec::new(),
                    live: None,
                },
            );
            return Err("stdio MCP 缺少 command".to_string());
        }
        if matches!(
            config.transport,
            McpTransport::Sse | McpTransport::StreamableHttp
        ) && config.url.trim().is_empty()
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                config.id.clone(),
                SessionSlot {
                    status: "error".to_string(),
                    error: Some("远程 MCP 缺少 url".to_string()),
                    tools: Vec::new(),
                    live: None,
                },
            );
            return Err("远程 MCP 缺少 url".to_string());
        }

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                config.id.clone(),
                SessionSlot {
                    status: "connecting".to_string(),
                    ..SessionSlot::default()
                },
            );
        }

        let result = match config.transport {
            McpTransport::Stdio => self.spawn_stdio_session(config).await,
            // URL 类统一走 streamable-http 客户端（兼容多数 Cursor 远程 MCP）
            McpTransport::Sse | McpTransport::StreamableHttp => {
                self.spawn_http_session(config).await
            }
        };

        match result {
            Ok(tools) => {
                let mut sessions = self.sessions.lock().await;
                if let Some(slot) = sessions.get_mut(&config.id) {
                    slot.status = "connected".to_string();
                    slot.error = None;
                    slot.tools = tools;
                }
                Ok(snapshot_server(config, sessions.get(&config.id)))
            }
            Err(error) => {
                let mut sessions = self.sessions.lock().await;
                sessions.insert(
                    config.id.clone(),
                    SessionSlot {
                        status: "error".to_string(),
                        error: Some(error.clone()),
                        tools: Vec::new(),
                        live: None,
                    },
                );
                Err(error)
            }
        }
    }

    async fn spawn_stdio_session(
        &self,
        config: &McpServerConfig,
    ) -> Result<Vec<McpToolInfo>, String> {
        let mut command = Command::new(&config.command);
        command.args(&config.args);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);
        #[cfg(windows)]
        {
            // Avoid flashing console windows for GUI-hosted stdio servers.
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        for (key, value) in &config.env {
            command.env(key, value);
        }
        // Windows 上 Python MCP（如 mcp-server-fetch）无 UTF-8 时可能异常；补默认编码
        #[cfg(windows)]
        {
            let has_ioencoding = config
                .env
                .keys()
                .any(|k| k.eq_ignore_ascii_case("PYTHONIOENCODING"));
            let has_utf8 = config.env.keys().any(|k| k.eq_ignore_ascii_case("PYTHONUTF8"));
            if !has_ioencoding {
                command.env("PYTHONIOENCODING", "utf-8");
            }
            if !has_utf8 {
                command.env("PYTHONUTF8", "1");
            }
        }
        if let Some(cwd) = config.cwd.as_ref() {
            command.current_dir(cwd);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 MCP 进程失败：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP 进程 stdin 不可用".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP 进程 stdout 不可用".to_string())?;
        let mut stderr = child.stderr.take();

        let pending_map: Arc<Mutex<HashMap<u64, PendingRequest>>> =
            Arc::new(Mutex::new(HashMap::new()));
        {
            let mut routes = self.response_routes.lock().await;
            routes.insert(config.id.clone(), Arc::clone(&pending_map));
        }

        // Drain stderr so the process never blocks on a full pipe.
        if let Some(stderr) = stderr.take() {
            let server_id = config.id.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let text = line.trim();
                            if !text.is_empty() {
                                eprintln!("[MCP {}] {text}", server_id);
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let reader_pending = Arc::clone(&pending_map);
        let reader_server_id = config.id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_mcp_message(&mut reader).await {
                    Ok(message) => {
                        if let Some(id) = message.get("id").and_then(Value::as_u64) {
                            let mut pending = reader_pending.lock().await;
                            if let Some(entry) = pending.remove(&id) {
                                if let Some(error) = message.get("error") {
                                    let text = error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("MCP 请求失败")
                                        .to_string();
                                    let _ = entry.response_tx.send(Err(text));
                                } else {
                                    let result = message.get("result").cloned().unwrap_or(Value::Null);
                                    let _ = entry.response_tx.send(Ok(result));
                                }
                            }
                        }
                        // notifications are ignored for now
                    }
                    Err(error) => {
                        eprintln!("[MCP {}] reader stopped: {error}", reader_server_id);
                        let mut pending = reader_pending.lock().await;
                        for (_, entry) in pending.drain() {
                            let _ = entry.response_tx.send(Err(error.clone()));
                        }
                        break;
                    }
                }
            }
        });

        let next_id = Arc::new(AtomicU64::new(1));
        let stdin = Arc::new(Mutex::new(stdin));
        let mut live = LiveStdioSession {
            child,
            stdin: Arc::clone(&stdin),
            next_id: Arc::clone(&next_id),
            tools: Vec::new(),
        };

        // initialize
        let init_result = request_on_session(
            &live.stdin,
            &live.next_id,
            &pending_map,
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "pandaterm",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
            MCP_INIT_TIMEOUT,
        )
        .await?;
        let _ = init_result;

        // notifications/initialized (no id)
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let frame = encode_mcp_message(&notification)?;
        {
            let mut stdin_guard = live.stdin.lock().await;
            stdin_guard
                .write_all(&frame)
                .await
                .map_err(|error| format!("MCP initialized 通知失败：{error}"))?;
            stdin_guard
                .flush()
                .await
                .map_err(|error| format!("MCP initialized 通知失败：{error}"))?;
        }

        let tools_result = request_on_session(
            &live.stdin,
            &live.next_id,
            &pending_map,
            "tools/list",
            json!({}),
            MCP_REQUEST_TIMEOUT,
        )
        .await?;
        let tools = parse_tools_list(&tools_result)?;
        live.tools = tools.clone();

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            config.id.clone(),
            SessionSlot {
                status: "connected".to_string(),
                error: None,
                tools: tools.clone(),
                live: Some(LiveSession::Stdio(live)),
            },
        );
        Ok(tools)
    }

    async fn spawn_http_session(
        &self,
        config: &McpServerConfig,
    ) -> Result<Vec<McpToolInfo>, String> {
        let url = config.url.trim().to_string();
        if url.is_empty() {
            return Err("远程 MCP 缺少 url".to_string());
        }
        let mut live = LiveHttpSession {
            client: self.http.clone(),
            url,
            headers: config.headers.clone(),
            session_id: None,
            next_id: AtomicU64::new(1),
            tools: Vec::new(),
        };

        let _init = http_jsonrpc_request(
            &mut live,
            "initialize",
            json!({
                "protocolVersion": MCP_HTTP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "pandaterm",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
            MCP_INIT_TIMEOUT,
            false,
        )
        .await?;

        // notifications/initialized
        let _ = http_jsonrpc_request(
            &mut live,
            "notifications/initialized",
            json!({}),
            MCP_REQUEST_TIMEOUT,
            true,
        )
        .await;

        let tools_result = http_jsonrpc_request(
            &mut live,
            "tools/list",
            json!({}),
            MCP_REQUEST_TIMEOUT,
            false,
        )
        .await?
        .ok_or_else(|| "MCP tools/list 无响应".to_string())?;
        let tools = parse_tools_list(&tools_result)?;
        live.tools = tools.clone();

        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            config.id.clone(),
            SessionSlot {
                status: "connected".to_string(),
                error: None,
                tools: tools.clone(),
                live: Some(LiveSession::Http(live)),
            },
        );
        Ok(tools)
    }

    pub async fn list_tools_catalog(&self, store: &McpConfigStore) -> Vec<Value> {
        let sessions = self.sessions.lock().await;
        let mut catalog = Vec::new();
        for server in store.servers.iter().filter(|server| server.enabled) {
            let Some(slot) = sessions.get(&server.id) else {
                continue;
            };
            if slot.status != "connected" {
                continue;
            }
            for tool in &slot.tools {
                catalog.push(json!({
                    "server": server.id,
                    "server_name": server.display_name(),
                    "tool": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }));
            }
        }
        catalog
    }

    pub async fn call_tool(
        &self,
        store: &McpConfigStore,
        request: CallMcpToolRequest,
    ) -> Result<CallMcpToolResult, String> {
        let server = store
            .servers
            .iter()
            .find(|item| item.id == request.server_id)
            .ok_or_else(|| format!("未找到 MCP 服务器：{}", request.server_id))?;
        if !server.enabled {
            return Err(format!("MCP 服务器已禁用：{}", request.server_id));
        }

        // Ensure connected
        let needs_connect = {
            let sessions = self.sessions.lock().await;
            !sessions
                .get(&server.id)
                .is_some_and(|slot| slot.status == "connected" && slot.live.is_some())
        };
        if needs_connect {
            self.connect_server(server).await?;
        }

        let tool_name = request.tool_name.trim();
        if tool_name.is_empty() || tool_name.chars().count() > 128 {
            return Err("MCP 工具名无效".to_string());
        }
        let arguments = request.arguments.unwrap_or_else(|| json!({}));

        // 取出 live，避免在 await 期间长期占用 sessions 锁
        let live = {
            let mut sessions = self.sessions.lock().await;
            let slot = sessions
                .get_mut(&server.id)
                .ok_or_else(|| "MCP 会话不存在".to_string())?;
            slot.live
                .take()
                .ok_or_else(|| "MCP 会话未连接".to_string())?
        };

        let result = match live {
            LiveSession::Stdio(stdio) => {
                let pending_map = {
                    let routes = self.response_routes.lock().await;
                    routes.get(&server.id).cloned()
                };
                let call = match pending_map {
                    Some(pending_map) => {
                        request_on_session(
                            &stdio.stdin,
                            &stdio.next_id,
                            &pending_map,
                            "tools/call",
                            json!({
                                "name": tool_name,
                                "arguments": arguments,
                            }),
                            MCP_REQUEST_TIMEOUT,
                        )
                        .await
                    }
                    None => Err("MCP 会话未就绪".to_string()),
                };
                let mut sessions = self.sessions.lock().await;
                if let Some(slot) = sessions.get_mut(&server.id) {
                    slot.live = Some(LiveSession::Stdio(stdio));
                }
                call
            }
            LiveSession::Http(mut http) => {
                let call = http_jsonrpc_request(
                    &mut http,
                    "tools/call",
                    json!({
                        "name": tool_name,
                        "arguments": arguments,
                    }),
                    MCP_REQUEST_TIMEOUT,
                    false,
                )
                .await
                .and_then(|value| value.ok_or_else(|| "MCP tools/call 无响应".to_string()));
                let mut sessions = self.sessions.lock().await;
                if let Some(slot) = sessions.get_mut(&server.id) {
                    slot.live = Some(LiveSession::Http(http));
                }
                call
            }
        };

        match result {
            Ok(value) => Ok(parse_tool_call_result(value)),
            Err(error) => {
                let mut sessions = self.sessions.lock().await;
                if let Some(slot) = sessions.get_mut(&server.id) {
                    slot.status = "error".to_string();
                    slot.error = Some(error.clone());
                    if let Some(live) = slot.live.take() {
                        live.shutdown().await;
                    }
                }
                self.response_routes.lock().await.remove(&server.id);
                Err(error)
            }
        }
    }
}

async fn http_jsonrpc_request(
    session: &mut LiveHttpSession,
    method: &str,
    params: Value,
    timeout: Duration,
    notification: bool,
) -> Result<Option<Value>, String> {
    let body = if notification {
        json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
    } else {
        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
    };
    let request_id = body.get("id").cloned();

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    headers.insert(
        HeaderName::from_static("mcp-protocol-version"),
        HeaderValue::from_static(MCP_HTTP_PROTOCOL_VERSION),
    );
    for (key, value) in &session.headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("无效 header 名：{key}"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| format!("无效 header 值：{key}"))?;
        headers.insert(name, header_value);
    }
    if let Some(session_id) = session.session_id.as_ref() {
        if let Ok(value) = HeaderValue::from_str(session_id) {
            headers.insert(
                HeaderName::from_static("mcp-session-id"),
                value,
            );
        }
    }

    let response = session
        .client
        .post(&session.url)
        .headers(headers)
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| format!("MCP HTTP 请求失败（{method}）：{error}"))?;

    if let Some(session_header) = response
        .headers()
        .get("mcp-session-id")
        .or_else(|| response.headers().get("Mcp-Session-Id"))
    {
        if let Ok(value) = session_header.to_str() {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                session.session_id = Some(trimmed.to_string());
            }
        }
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let text = response
        .text()
        .await
        .map_err(|error| format!("MCP HTTP 响应读取失败：{error}"))?;

    // 202 / 空 body：通知常见；非通知则视为无结果
    if text.trim().is_empty() {
        if notification || status.as_u16() == 202 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("MCP HTTP {}（{method}）", status.as_u16()));
        }
        return Err(format!("MCP HTTP 响应为空（{method}）"));
    }

    if !status.is_success() {
        let snippet: String = text.chars().take(400).collect();
        return Err(format!(
            "MCP HTTP {}（{method}）：{snippet}",
            status.as_u16()
        ));
    }

    if notification {
        return Ok(None);
    }

    let request_id = request_id.ok_or_else(|| "MCP 请求缺少 id".to_string())?;
    if content_type.contains("text/event-stream") || text.trim_start().starts_with("event:") || text.contains("\ndata:") {
        parse_sse_jsonrpc_result(&text, &request_id).map(Some)
    } else {
        parse_jsonrpc_result(&text, &request_id).map(Some)
    }
}

fn jsonrpc_id_matches(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    match (left.as_u64(), right.as_u64()) {
        (Some(a), Some(b)) => a == b,
        _ => match (left.as_i64(), right.as_i64()) {
            (Some(a), Some(b)) => a == b,
            _ => left.as_str().is_some_and(|a| right.as_str() == Some(a)),
        },
    }
}

fn parse_jsonrpc_result(text: &str, request_id: &Value) -> Result<Value, String> {
    let message: Value = serde_json::from_str(text.trim())
        .map_err(|error| format!("MCP HTTP JSON 无效：{error}"))?;
    if let Some(id) = message.get("id") {
        if !jsonrpc_id_matches(id, request_id) {
            return Err("MCP HTTP 响应 id 不匹配".to_string());
        }
    }
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP 请求失败")
            .to_string();
        return Err(text);
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

fn parse_sse_jsonrpc_result(text: &str, request_id: &Value) -> Result<Value, String> {
    let mut data_blocks: Vec<String> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            if !current.is_empty() {
                data_blocks.push(current.join("\n"));
                current.clear();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            current.push(rest.trim_start().to_string());
        }
    }
    if !current.is_empty() {
        data_blocks.push(current.join("\n"));
    }

    let mut last_error = "MCP SSE 响应中没有 JSON-RPC 结果".to_string();
    for block in data_blocks {
        let trimmed = block.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            continue;
        }
        match parse_jsonrpc_result(trimmed, request_id) {
            Ok(result) => return Ok(result),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

async fn request_on_session(
    stdin: &Arc<Mutex<ChildStdin>>,
    next_id: &Arc<AtomicU64>,
    pending_map: &Arc<Mutex<HashMap<u64, PendingRequest>>>,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = pending_map.lock().await;
        pending.insert(id, PendingRequest { response_tx: tx });
    }
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let frame = encode_mcp_message(&body)?;
    {
        let mut stdin_guard = stdin.lock().await;
        if let Err(error) = stdin_guard.write_all(&frame).await {
            let mut pending = pending_map.lock().await;
            pending.remove(&id);
            return Err(format!("MCP 请求写入失败：{error}"));
        }
        if let Err(error) = stdin_guard.flush().await {
            let mut pending = pending_map.lock().await;
            pending.remove(&id);
            return Err(format!("MCP 请求写入失败：{error}"));
        }
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("MCP 请求通道已关闭".to_string()),
        Err(_) => {
            let mut pending = pending_map.lock().await;
            pending.remove(&id);
            Err(format!("MCP 请求超时（{method}）"))
        }
    }
}

fn parse_tools_list(result: &Value) -> Result<Vec<McpToolInfo>, String> {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list 响应无效".to_string())?;
    let mut out = Vec::new();
    for tool in tools.iter().take(MAX_MCP_TOOLS) {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let description = tool
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .chars()
            .take(2_000)
            .collect::<String>();
        let input_schema = tool.get("inputSchema").cloned();
        out.push(McpToolInfo {
            name,
            description,
            input_schema,
        });
    }
    Ok(out)
}

fn parse_tool_call_result(value: Value) -> CallMcpToolResult {
    let is_error = value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = if let Some(parts) = value.get("content").and_then(Value::as_array) {
        let text = parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
                if kind == "text" {
                    part.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    Some(part.to_string())
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            value.to_string()
        } else {
            text
        }
    } else {
        value.to_string()
    };
    let mut content = content;
    if content.chars().count() > MAX_CALL_RESULT_CHARS {
        content = content.chars().take(MAX_CALL_RESULT_CHARS).collect::<String>()
            + "\n\n[...MCP 结果已截断...]";
    }
    CallMcpToolResult { content, is_error }
}

// ── Agent helper text ───────────────────────────────────────────────────

#[allow(dead_code)]
pub fn format_mcp_tools_for_agent(catalog: &[Value]) -> String {
    if catalog.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    lines.push("已连接的 MCP 工具（仅可在 Agent 模式通过 pandaterm-mcp 代码块调用，须用户授权）：".to_string());
    for item in catalog.iter().take(80) {
        let server = item.get("server").and_then(Value::as_str).unwrap_or("?");
        let tool = item.get("tool").and_then(Value::as_str).unwrap_or("?");
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(160)
            .collect::<String>();
        if description.is_empty() {
            lines.push(format!("- {server}/{tool}"));
        } else {
            lines.push(format!("- {server}/{tool}: {description}"));
        }
    }
    lines.push(
        "调用格式：```pandaterm-mcp\\n{\"summary\":\"...\",\"server\":\"服务器id\",\"tool\":\"工具名\",\"arguments\":{}}\\n```".to_string(),
    );
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_stdio_and_reject_duplicate() {
        let servers = normalize_mcp_servers(vec![McpServerConfig {
            id: "fs".into(),
            name: "Filesystem".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()],
            env: HashMap::new(),
            cwd: None,
            url: String::new(),
            headers: HashMap::new(),
            enabled: true,
        }])
        .expect("normalize");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].command, "npx");

        let err = normalize_mcp_servers(vec![
            McpServerConfig {
                id: "fs".into(),
                name: String::new(),
                transport: McpTransport::Stdio,
                command: "npx".into(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: None,
                url: String::new(),
                headers: HashMap::new(),
                enabled: true,
            },
            McpServerConfig {
                id: "fs".into(),
                name: String::new(),
                transport: McpTransport::Stdio,
                command: "node".into(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: None,
                url: String::new(),
                headers: HashMap::new(),
                enabled: true,
            },
        ])
        .expect_err("duplicate");
        assert!(err.contains("重复"));
    }

    #[test]
    fn parse_cursor_mcp_shape() {
        let raw = r#"{
            "mcpServers": {
                "memory": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-memory"],
                    "disabled": false
                },
                "remote": {
                    "url": "https://example.com/mcp",
                    "headers": { "Authorization": "Bearer x" }
                }
            }
        }"#;
        let cursor: CursorMcpFile = serde_json::from_str(raw).expect("cursor file");
        assert_eq!(cursor.mcp_servers.len(), 2);
        let memory = cursor_server_to_config(
            "memory".into(),
            cursor.mcp_servers.get("memory").cloned().unwrap(),
        );
        assert!(matches!(memory.transport, McpTransport::Stdio));
        assert_eq!(memory.command, "npx");
        let remote = cursor_server_to_config(
            "remote".into(),
            cursor.mcp_servers.get("remote").cloned().unwrap(),
        );
        assert!(matches!(remote.transport, McpTransport::StreamableHttp));
        assert!(remote.url.starts_with("https://"));

        let store = parse_mcp_config_content(raw).expect("parse content");
        assert_eq!(store.servers.len(), 2);
    }

    #[test]
    fn merge_import_overwrites_same_id() {
        let existing = vec![McpServerConfig {
            id: "memory".into(),
            name: "Old".into(),
            transport: McpTransport::Stdio,
            command: "old".into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            url: String::new(),
            headers: HashMap::new(),
            enabled: false,
        }];
        let imported = vec![McpServerConfig {
            id: "memory".into(),
            name: "memory".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into()],
            env: HashMap::new(),
            cwd: None,
            url: String::new(),
            headers: HashMap::new(),
            enabled: true,
        }, McpServerConfig {
            id: "fs".into(),
            name: "fs".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            url: String::new(),
            headers: HashMap::new(),
            enabled: false,
        }];
        let (merged, added, updated) =
            merge_mcp_server_imports(existing.clone(), imported.clone()).expect("merge");
        assert_eq!(added, 1);
        assert_eq!(updated, 1);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].command, "npx");
        assert_eq!(merged[0].name, "memory");
        assert_eq!(merged[1].id, "fs");

        let (skipped_merge, added2, updated2) =
            merge_mcp_server_imports_with_strategy(existing, imported, false).expect("skip");
        assert_eq!(added2, 1);
        assert_eq!(updated2, 0);
        assert_eq!(skipped_merge[0].command, "old");
    }

    #[test]
    fn export_cursor_shape_roundtrip() {
        let servers = vec![
            McpServerConfig {
                id: "memory".into(),
                name: "memory".into(),
                transport: McpTransport::Stdio,
                command: "npx".into(),
                args: vec!["-y".into(), "@modelcontextprotocol/server-memory".into()],
                env: HashMap::new(),
                cwd: None,
                url: String::new(),
                headers: HashMap::new(),
                enabled: true,
            },
            McpServerConfig {
                id: "remote".into(),
                name: "remote".into(),
                transport: McpTransport::StreamableHttp,
                command: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: None,
                url: "https://example.com/mcp".into(),
                headers: HashMap::from([("Authorization".into(), "Bearer x".into())]),
                enabled: false,
            },
        ];
        let exported = export_mcp_servers_cursor_json(&servers).expect("export");
        let reimported = parse_mcp_config_content(&exported).expect("reimport");
        assert_eq!(reimported.servers.len(), 2);
        assert!(reimported.servers.iter().any(|s| s.id == "memory" && s.command == "npx"));
        assert!(reimported
            .servers
            .iter()
            .any(|s| s.id == "remote" && !s.enabled && s.url.starts_with("https://")));
    }

    #[test]
    fn parse_sse_and_json_http_results() {
        let id = json!(1);
        let json_body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}"#;
        let result = parse_jsonrpc_result(json_body, &id).expect("json");
        assert_eq!(result["tools"][0]["name"], "a");

        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let sse_result = parse_sse_jsonrpc_result(sse, &id).expect("sse");
        assert_eq!(sse_result["ok"], true);
    }

    #[test]
    fn encode_mcp_message_uses_ndjson() {
        let frame = encode_mcp_message(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).expect("encode");
        let text = String::from_utf8(frame).expect("utf8");
        assert!(text.ends_with('\n'));
        assert!(!text.contains("Content-Length"));
        let line = text.trim_end_matches('\n');
        let value: Value = serde_json::from_str(line).expect("json line");
        assert_eq!(value["method"], "initialize");
    }

    #[test]
    fn parse_tools_and_call_result() {
        let tools = parse_tools_list(&json!({
            "tools": [
                { "name": "read_file", "description": "Read a file", "inputSchema": { "type": "object" } },
                { "name": "  ", "description": "skip" }
            ]
        }))
        .expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read_file");

        let result = parse_tool_call_result(json!({
            "content": [{ "type": "text", "text": "hello" }],
            "isError": false
        }));
        assert_eq!(result.content, "hello");
        assert!(!result.is_error);
    }
}

// Helper: CursorMcpServer needs Clone for test
impl Clone for CursorMcpServer {
    fn clone(&self) -> Self {
        Self {
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            cwd: self.cwd.clone(),
            url: self.url.clone(),
            headers: self.headers.clone(),
            disabled: self.disabled,
            transport: self.transport.clone(),
        }
    }
}