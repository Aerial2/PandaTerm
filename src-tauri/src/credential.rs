use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use panda_crypto::{protect_secret, unprotect_secret, ProtectedSecret, ProtectionMode};

use crate::storage::{atomic_write_text, credential_vault_path};

pub const CREDENTIAL_VAULT_VERSION: u8 = 1;
pub const CREDENTIAL_ID_PREFIX: &str = "credential:";
pub const CREDENTIAL_VERIFIER_CONTEXT: &str = "pandaterm:credential-verifier";
pub const CREDENTIAL_VERIFIER_VALUE: &str = "pandaterm-master-password-verifier-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialVault {
    pub version: u8,
    pub mode: ProtectionMode,
    pub verifier: Option<ProtectedSecret>,
    pub entries: HashMap<String, ProtectedSecret>,
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

pub struct CredentialVaultState {
    pub vault: CredentialVault,
    pub master_password: Option<String>,
    pub load_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialStatus {
    pub mode: ProtectionMode,
    pub locked: bool,
    pub credential_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialProtectionRequest {
    pub mode: ProtectionMode,
    pub master_password: Option<String>,
}

pub fn credential_context(id: &str) -> String {
    format!("pandaterm:credential:{id}")
}

pub fn credential_id(session_id: Uuid, kind: &str) -> String {
    format!("{CREDENTIAL_ID_PREFIX}{session_id}:{kind}")
}

pub fn is_credential_id(value: &str) -> bool {
    value.starts_with(CREDENTIAL_ID_PREFIX)
}

pub fn load_credential_vault() -> Result<CredentialVault, String> {
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

pub fn save_credential_vault(vault: &CredentialVault) -> Result<(), String> {
    let path = credential_vault_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("凭据目录创建失败：{error}"))?;
    }
    let content = serde_json::to_string_pretty(vault)
        .map_err(|error| format!("凭据序列化失败：{error}"))?;
    atomic_write_text(&path, &content).map_err(|error| format!("凭据保存失败：{error}"))
}

pub fn ensure_vault_available(state: &CredentialVaultState) -> Result<(), String> {
    match &state.load_error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

pub fn credential_status_snapshot(state: &CredentialVaultState) -> CredentialStatus {
    CredentialStatus {
        mode: state.vault.mode,
        locked: state.load_error.is_some()
            || (state.vault.mode == ProtectionMode::MasterPassword
                && state.master_password.is_none()),
        credential_count: state.vault.entries.len(),
        error: state.load_error.clone(),
    }
}

pub fn vault_master_password(state: &CredentialVaultState) -> Result<Option<&str>, String> {
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

pub fn resolve_credential(state: &CredentialVaultState, id: &str) -> Result<String, String> {
    let protected = state
        .vault
        .entries
        .get(id)
        .ok_or_else(|| format!("未找到连接凭据：{id}"))?;
    unprotect_secret(protected, vault_master_password(state)?, &credential_context(id))
        .map_err(|error| format!("凭据解密失败：{error}"))
}

pub fn store_credential(
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
