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

pub(crate) fn verify_or_trust_host_key(host_port: &str, key: &russh::keys::PublicKey) -> Result<bool, String> {
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
