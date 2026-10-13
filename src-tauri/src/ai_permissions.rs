use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ai_tools::{AiPermissionPolicy, ToolKind};
use crate::storage::{atomic_write_text, pandaterm_data_dir};

pub const AI_PERMISSION_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiAllowlistRule {
    pub id: String,
    pub kind: ToolKind,
    pub name: String,
    pub target: String,
    pub arguments_identity: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub preparation_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiPermissionStore {
    pub version: u8,
    pub policy: AiPermissionPolicy,
    #[serde(default)]
    pub rules: Vec<AiAllowlistRule>,
}

impl Default for AiPermissionStore {
    fn default() -> Self {
        Self {
            version: AI_PERMISSION_VERSION,
            policy: AiPermissionPolicy::Ask,
            rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AiPermissionSnapshot {
    pub policy: AiPermissionPolicy,
    pub rules: Vec<AiAllowlistRule>,
    pub error: Option<String>,
}

pub fn permission_path() -> Result<PathBuf, String> {
    Ok(pandaterm_data_dir()?.join("ai-permissions.json"))
}

pub fn load(path: &Path) -> Result<AiPermissionStore, String> {
    if !path.exists() {
        return Ok(AiPermissionStore::default());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("AI 权限设置读取失败：{e}"))?;
    let store: AiPermissionStore =
        serde_json::from_str(&text).map_err(|e| format!("AI 权限设置损坏：{e}"))?;
    if store.version != AI_PERMISSION_VERSION {
        return Err(format!("AI 权限设置版本不受支持：{}", store.version));
    }
    if store.rules.len() > 2048 {
        return Err("AI 权限规则过多".into());
    }
    for rule in &store.rules {
        Uuid::parse_str(&rule.id).map_err(|_| "AI 权限规则标识无效".to_string())?;
        if rule.arguments_identity.len() != 64
            || !rule
                .arguments_identity
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err("AI 权限规则身份无效".into());
        }
        if rule.target.is_empty() || rule.name.is_empty() || rule.timeout_ms == 0 {
            return Err("AI 权限规则内容无效".into());
        }
        if let Some(preparation_identity) = &rule.preparation_identity {
            if preparation_identity.len() != 64
                || !preparation_identity
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("AI 权限准备身份无效".into());
            }
        }
    }
    Ok(store)
}

pub fn save(path: &Path, store: &AiPermissionStore) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(store).map_err(|e| format!("AI 权限设置序列化失败：{e}"))?;
    atomic_write_text(path, &text)
}

pub fn canonical_json(value: &serde_json::Value) -> String {
    fn sorted(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => {
                let ordered: std::collections::BTreeMap<_, _> =
                    map.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
                serde_json::Value::Object(ordered.into_iter().collect())
            }
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(sorted).collect())
            }
            _ => value.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).expect("JSON values serialize")
}

pub fn rule_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn identity(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub fn matches(
    rule: &AiAllowlistRule,
    kind: ToolKind,
    name: &str,
    target: &str,
    args: &str,
    timeout_ms: u64,
) -> bool {
    rule.kind == kind
        && rule.name == name
        && rule.target == target
        && rule.arguments_identity == args
        && rule.timeout_ms == timeout_ms
}

pub fn matches_preparation(
    rule: &AiAllowlistRule,
    kind: ToolKind,
    name: &str,
    target: &str,
    preparation: &str,
    timeout_ms: u64,
) -> bool {
    rule.kind == kind
        && rule.name == name
        && rule.target == target
        && rule.preparation_identity.as_deref() == Some(preparation)
        && rule.timeout_ms == timeout_ms
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_identity_has_no_prefix_or_content_or_timeout_grants() {
        let digest = identity(&["original", "new"]);
        let rule = AiAllowlistRule {
            id: rule_id(),
            kind: ToolKind::FileEdit,
            name: "propose_file_edit".into(),
            target: "local:/a/file".into(),
            arguments_identity: digest.clone(),
            timeout_ms: 120_000,
            preparation_identity: None,
        };
        assert!(matches(
            &rule,
            rule.kind,
            &rule.name,
            &rule.target,
            &digest,
            120_000
        ));
        for target in ["local:/a/file2", "remote:uuid:/a/file"] {
            assert!(!matches(
                &rule, rule.kind, &rule.name, target, &digest, 120_000
            ));
        }
        assert!(!matches(
            &rule,
            rule.kind,
            &rule.name,
            &rule.target,
            &identity(&["different", "new"]),
            120_000
        ));
        assert!(!matches(
            &rule,
            rule.kind,
            &rule.name,
            &rule.target,
            &digest,
            1000
        ));
        assert_ne!(identity(&["ab", "c"]), identity(&["a", "bc"]));
    }

    #[test]
    fn canonical_arguments_and_config_are_recursive_and_replacement_sensitive() {
        let a: serde_json::Value =
            serde_json::from_str(r#"{"b":{"y":2,"x":1},"a":[{"z":0,"a":1}]}"#).unwrap();
        let b: serde_json::Value =
            serde_json::from_str(r#"{"a":[{"a":1,"z":0}],"b":{"x":1,"y":2}}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_ne!(
            identity(&[&canonical_json(&json!({"id":"same","command":"old"}))]),
            identity(&[&canonical_json(
                &json!({"id":"same","command":"replacement"})
            )])
        );
    }

    #[test]
    fn preparation_and_write_identities_are_separate_exact_grants() {
        let proposal = identity(&["proposal"]);
        let original = identity(&["old", "new"]);
        let rule = AiAllowlistRule {
            id: rule_id(),
            kind: ToolKind::FileEdit,
            name: "propose_file_edit".into(),
            target: "local:/tmp/file".into(),
            arguments_identity: original.clone(),
            timeout_ms: 120_000,
            preparation_identity: Some(proposal.clone()),
        };
        assert!(matches_preparation(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/file",
            &proposal,
            120_000
        ));
        assert!(!matches_preparation(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/other",
            &proposal,
            120_000
        ));
        assert!(!matches_preparation(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/file",
            &identity(&["other-proposal"]),
            120_000
        ));
        assert!(!matches_preparation(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/file",
            &proposal,
            60_000
        ));
        assert!(matches(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/file",
            &original,
            120_000
        ));
        assert!(!matches(
            &rule,
            ToolKind::FileEdit,
            "propose_file_edit",
            "local:/tmp/file",
            &identity(&["changed", "new"]),
            120_000
        ));
    }

    #[test]
    fn malformed_preparation_identity_fails_closed() {
        let dir = std::env::temp_dir().join(format!("pandaterm-permissions-{}", Uuid::new_v4()));
        let path = dir.join("settings.json");
        let mut store = AiPermissionStore::default();
        store.rules.push(AiAllowlistRule {
            id: rule_id(),
            kind: ToolKind::FileEdit,
            name: "propose_file_edit".into(),
            target: "local:/tmp/file".into(),
            arguments_identity: identity(&["old", "new"]),
            timeout_ms: 120_000,
            preparation_identity: Some("short".into()),
        });
        save(&path, &store).unwrap();
        assert!(load(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn storage_round_trip_missing_and_corrupt_fail_closed() {
        let dir = std::env::temp_dir().join(format!("pandaterm-permissions-{}", Uuid::new_v4()));
        let path = dir.join("settings.json");
        assert_eq!(load(&path).unwrap().policy, AiPermissionPolicy::Ask);
        let mut store = AiPermissionStore::default();
        store.policy = AiPermissionPolicy::Allowlist;
        store.rules.push(AiAllowlistRule {
            id: rule_id(),
            kind: ToolKind::Terminal,
            name: "run_terminal_command".into(),
            target: "local:uuid".into(),
            arguments_identity: identity(&["command"]),
            timeout_ms: 3000,
            preparation_identity: None,
        });
        save(&path, &store).unwrap();
        let restored = load(&path).unwrap();
        assert_eq!(restored.policy, store.policy);
        assert_eq!(restored.rules, store.rules);
        for text in [
            "{",
            r#"{"version":99,"policy":"full","rules":[]}"#,
            r#"{"version":1,"policy":"bogus","rules":[]}"#,
            r#"{"version":1}"#,
        ] {
            fs::write(&path, text).unwrap();
            assert!(load(&path).is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
