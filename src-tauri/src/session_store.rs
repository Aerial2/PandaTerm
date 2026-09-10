//! Session persistence + credential resolution domain: load/save the session
//! store (JSON), merge imported Xshell sessions, run the one-time legacy
//! credential migration into the vault, and resolve stored secret ids back to
//! plaintext for outbound connections.

use std::fs;

use panda_session::{AuthType, Session};

use crate::credential::{
    credential_id, is_credential_id, load_credential_vault, resolve_credential,
    save_credential_vault, store_credential, CredentialVault, CredentialVaultState,
};
use crate::legacy_secret::deobfuscate_secret;
use crate::storage::{atomic_write_text, session_store_path};
use crate::xshell::load_xshell_sessions;

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

pub(crate) fn save_persistent_sessions(sessions: &[Session]) -> Result<(), String> {
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

pub(crate) fn migrate_legacy_credentials(
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

pub(crate) fn load_secure_state() -> (Vec<Session>, CredentialVaultState, Option<String>) {
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

pub(crate) fn resolved_session(session: &Session, credentials: &CredentialVaultState) -> Result<Session, String> {
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
