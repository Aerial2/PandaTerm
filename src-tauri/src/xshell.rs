use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use panda_session::{AuthType, ReconnectPolicy, Session};

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

pub fn load_xshell_sessions() -> Vec<Session> {
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
