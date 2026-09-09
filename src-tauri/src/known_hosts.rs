//! SSH known_hosts trust store: load/save the host fingerprint map and
//! verify first-use / changed-host-key decisions (TOFU with MITM detection).
//!
//! 首次使用不再静默信任：由调用方（`main.rs::ensure_host_key_trusted_blocking`）
//! 先用 [`check_fingerprint`] 判定是否为“首见”，经用户确认后再调用
//! [`trust_fingerprint`] 落库。本模块只做纯存储与比对。

use std::collections::HashMap;
use std::fs;

use crate::storage::known_hosts_path;

pub(crate) enum FingerprintCheck {
    /// 已存储且与本次一致
    Trusted,
    /// 首次见到该主机，需要用户确认后才可信任
    Unknown,
}

fn load_known_hosts() -> HashMap<String, String> {
    let Ok(path) = known_hosts_path() else {
        return HashMap::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    match serde_json::from_str(&content) {
        Ok(hosts) => hosts,
        Err(error) => {
            // 信任库损坏：留痕并把损坏文件改名备份（可人工恢复），
            // 避免无感清零后下次连接全部变“首见”重新弹确认
            eprintln!(
                "[HostKey] WARNING: known_hosts.json is corrupt ({error}); backing up and resetting trust store"
            );
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = std::path::PathBuf::from(format!("{}.corrupt-{}", path.display(), ts));
            let _ = fs::rename(&path, &backup);
            HashMap::new()
        }
    }
}

pub(crate) fn save_known_hosts(hosts: &HashMap<String, String>) -> Result<(), String> {
    let path = known_hosts_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("known_hosts 目录创建失败：{e}"))?;
    }
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("known_hosts 序列化失败：{e}"))?;
    crate::storage::atomic_write_text(&path, &content)
        .map_err(|e| format!("known_hosts 写入失败：{e}"))
}

fn host_key_fingerprint(key: &russh::keys::PublicKey) -> String {
    // algorithm + base64 public key material for stable MITM detection.
    use russh::keys::PublicKeyBase64;
    let alg = key.algorithm().to_string();
    format!("{alg}:{}", key.public_key_base64())
}

/// 计算服务器公钥的稳定指纹字符串（SSH：`alg:base64`），供确认对话框展示与存库比对。
pub(crate) fn ssh_server_fingerprint(key: &russh::keys::PublicKey) -> String {
    host_key_fingerprint(key)
}

/// 按 host_port 键比对已有指纹。指纹发生变化即视为潜在 MITM 直接报错；
/// 首见返回 [`FingerprintCheck::Unknown`]，信任与否交由调用方与用户决定。
pub(crate) fn check_fingerprint(
    host_port: &str,
    fingerprint: &str,
) -> Result<FingerprintCheck, String> {
    let hosts = load_known_hosts();
    match hosts.get(host_port) {
        Some(known) if known == fingerprint => Ok(FingerprintCheck::Trusted),
        Some(known) => {
            eprintln!(
                "[HostKey] key mismatch for {host_port}: known={known} now={fingerprint}"
            );
            Err(format!(
                "主机密钥已变更（{host_port}），可能存在中间人风险。若确认服务器已重装，请删除 ~/.pandaterm/known_hosts.json 后重试"
            ))
        }
        None => Ok(FingerprintCheck::Unknown),
    }
}

/// 用户确认后把首见指纹写入信任库。
pub(crate) fn trust_fingerprint(host_port: &str, fingerprint: &str) -> Result<(), String> {
    let mut hosts = load_known_hosts();
    hosts.insert(host_port.to_string(), fingerprint.to_string());
    save_known_hosts(&hosts)?;
    eprintln!("[HostKey] trusted new host key for {host_port}");
    Ok(())
}
