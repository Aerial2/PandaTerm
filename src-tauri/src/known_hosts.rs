//! SSH known_hosts trust store: load/save the host fingerprint map and
//! verify-or-trust a server public key on connect (TOFU with MITM detection).

use std::collections::HashMap;
use std::fs;

use crate::storage::known_hosts_path;

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

/// 通用 TOFU 校验：按 host_port 键比对指纹。首见即信任并落盘；已存在但指纹变化则报错
/// （潜在 MITM）。指纹算法由调用方按协议自定（SSH=alg:base64、RDP=sha256:hex），本函数
/// 只做存储与比对，故与密钥类型解耦。label 仅用于日志/错误文案（如 "SSH"/"RDP"）。
pub(crate) fn verify_or_trust_fingerprint(
    host_port: &str,
    fingerprint: &str,
    label: &str,
) -> Result<bool, String> {
    let mut hosts = load_known_hosts();
    match hosts.get(host_port) {
        Some(known) if known == fingerprint => Ok(true),
        Some(known) => {
            eprintln!(
                "[{label}] host key mismatch for {host_port}: known={known} now={fingerprint}"
            );
            Err(format!(
                "主机密钥已变更（{host_port}），可能存在中间人风险。若确认服务器已重装，请删除 ~/.pandaterm/known_hosts.json 后重试"
            ))
        }
        None => {
            hosts.insert(host_port.to_string(), fingerprint.to_string());
            save_known_hosts(&hosts)?;
            eprintln!("[{label}] trusted new host key for {host_port}");
            Ok(true)
        }
    }
}

pub(crate) fn verify_or_trust_host_key(host_port: &str, key: &russh::keys::PublicKey) -> Result<bool, String> {
    let fingerprint = host_key_fingerprint(key);
    verify_or_trust_fingerprint(host_port, &fingerprint, "SSH")
}
