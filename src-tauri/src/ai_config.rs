use std::collections::HashSet;
use std::fs;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::storage::{ai_config_path, atomic_write_text};

pub const MAX_AI_MODELS: usize = 500;
pub const MAX_AI_ACCOUNTS: usize = 32;
pub const AI_CONFIG_VERSION: u8 = 2;
pub const DEFAULT_AI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_AI_MODEL: &str = "gpt-4o-mini";
/// 默认不启用 reasoning_effort，兼容非推理模型
pub const DEFAULT_AI_REASONING_EFFORT: &str = "none";
/// 默认 OpenAI 兼容协议
pub const DEFAULT_AI_API_FORMAT: &str = "openai";
/// 默认上下文窗口（token）；前端据此换算上下文用量预算
pub const DEFAULT_AI_CONTEXT_WINDOW: u32 = 128_000;
/// 默认最大输出 token；0 = 不限制（OpenAI 不带 max_tokens，Claude 走兜底值）
pub const DEFAULT_AI_MAX_TOKENS: u32 = 0;
/// Claude Messages API 必须带 max_tokens，未配置时兜底 8192（保持历史行为）
pub const AI_CLAUDE_FALLBACK_MAX_TOKENS: u32 = 8192;
pub const MIN_AI_CONTEXT_WINDOW: u32 = 1_000;
pub const MAX_AI_CONTEXT_WINDOW: u32 = 2_000_000;
pub const MAX_AI_OUTPUT_TOKENS: u32 = 1_000_000;

pub fn validate_ai_model(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    if model.len() > 200 || model.chars().any(char::is_control) {
        return Err("模型名称无效".to_string());
    }
    Ok(model.to_string())
}

/// OpenAI-compatible reasoning_effort；`none` 表示请求体不带该字段
pub fn validate_ai_reasoning_effort(effort: &str) -> Result<String, String> {
    let effort = effort.trim().to_ascii_lowercase();
    match effort.as_str() {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => Ok(effort),
        _ => Err("推理强度无效，可选：none / minimal / low / medium / high / xhigh".to_string()),
    }
}

pub fn validate_ai_api_format(format: &str) -> Result<String, String> {
    match format.trim().to_ascii_lowercase().as_str() {
        "openai" => Ok("openai".to_string()),
        "claude" | "anthropic" => Ok("claude".to_string()),
        _ => Err("接口兼容格式无效，可选：openai / claude".to_string()),
    }
}

pub fn is_claude_api_format(format: &str) -> bool {
    format.eq_ignore_ascii_case("claude")
}

/// 仅在非 none 时注入 chat completions 请求字段
pub fn ai_request_reasoning_effort(effort: &str) -> Option<&str> {
    let effort = effort.trim();
    if effort.is_empty() || effort.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(effort)
    }
}

/// 上下文窗口（token）：0 视为未设置 → 回落到默认值
pub fn validate_ai_context_window(value: u32) -> Result<u32, String> {
    if value == 0 {
        return Ok(DEFAULT_AI_CONTEXT_WINDOW);
    }
    if !(MIN_AI_CONTEXT_WINDOW..=MAX_AI_CONTEXT_WINDOW).contains(&value) {
        return Err(format!(
            "上下文窗口需在 {MIN_AI_CONTEXT_WINDOW} ~ {MAX_AI_CONTEXT_WINDOW} token 之间"
        ));
    }
    Ok(value)
}

/// 最大输出 token：0 = 不限制
pub fn validate_ai_max_tokens(value: u32) -> Result<u32, String> {
    if value > MAX_AI_OUTPUT_TOKENS {
        return Err(format!("最大输出 Token 不能超过 {MAX_AI_OUTPUT_TOKENS}"));
    }
    Ok(value)
}

/// OpenAI 请求：0 表示不注入 max_tokens（沿用服务端默认）
pub fn ai_request_max_tokens(max_tokens: u32) -> Option<u32> {
    if max_tokens == 0 {
        None
    } else {
        Some(max_tokens)
    }
}

/// 校验模型列表，并保证当前选中模型一定在列表内
pub fn normalize_ai_models(models: &[String], selected: &str) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for model in models {
        let model = validate_ai_model(model)?;
        if !normalized.iter().any(|item| item == &model) {
            normalized.push(model);
        }
        if normalized.len() > MAX_AI_MODELS {
            return Err(format!("模型列表不能超过 {MAX_AI_MODELS} 个"));
        }
    }
    let selected = validate_ai_model(selected)?;
    if !normalized.iter().any(|item| item == &selected) {
        if normalized.len() >= MAX_AI_MODELS {
            return Err(format!("模型列表不能超过 {MAX_AI_MODELS} 个"));
        }
        normalized.insert(0, selected);
    }
    Ok(normalized)
}

/// 规范化"聊天可见"模型：必须是 models 子集，且包含当前 model。
/// 旧配置无 enabled_models 时默认启用全部 models（保持既有行为）。
pub fn normalize_enabled_ai_models(
    models: &[String],
    enabled: &[String],
    selected: &str,
) -> Result<Vec<String>, String> {
    let catalog: HashSet<&str> = models.iter().map(String::as_str).collect();
    let selected = validate_ai_model(selected)?;
    if !catalog.contains(selected.as_str()) {
        return Err("当前模型不在模型目录内".to_string());
    }

    let mut normalized = Vec::new();
    let source = if enabled.is_empty() {
        models
    } else {
        enabled
    };
    for model in source {
        let model = validate_ai_model(model)?;
        if catalog.contains(model.as_str()) && !normalized.iter().any(|item| item == &model) {
            normalized.push(model);
        }
    }
    if !normalized.iter().any(|item| item == &selected) {
        normalized.insert(0, selected);
    }
    Ok(normalized)
}

/// 同步合并：远端 id 命中本地则覆盖该条目；未命中的本地自定义保留
pub fn merge_ai_models(existing: &[String], synced: &[String]) -> Result<Vec<String>, String> {
    let mut synced_normalized = Vec::new();
    for model in synced {
        let model = validate_ai_model(model)?;
        if !synced_normalized.iter().any(|item| item == &model) {
            synced_normalized.push(model);
        }
    }
    let synced_set: HashSet<&str> = synced_normalized.iter().map(String::as_str).collect();
    let mut merged = Vec::new();
    for model in existing {
        let model = validate_ai_model(model)?;
        if synced_set.contains(model.as_str()) {
            // 同名自定义被远端覆盖：仅在首次遇到时放入远端规范值
            if !merged.iter().any(|item| item == &model) {
                merged.push(model);
            }
            continue;
        }
        if !merged.iter().any(|item| item == &model) {
            merged.push(model);
        }
    }
    for model in synced_normalized {
        if !merged.iter().any(|item| item == &model) {
            merged.push(model);
        }
    }
    if merged.len() > MAX_AI_MODELS {
        merged.truncate(MAX_AI_MODELS);
    }
    Ok(merged)
}

pub fn validate_ai_base_url(base_url: &str) -> Result<Url, String> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url = Url::parse(&candidate).map_err(|error| format!("Base URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 只支持 HTTP 或 HTTPS".to_string());
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Base URL 必须包含有效域名，且不能内嵌账号密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Base URL 不能包含查询参数或片段".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub fn ai_resource_url(base_url: &str, resource: &str) -> Result<Url, String> {
    let mut url = validate_ai_base_url(base_url)?;
    let path = url.path().trim_end_matches('/');
    let resource = resource.trim_matches('/');
    let endpoint = if path.ends_with(&format!("/{resource}")) || path == resource {
        path.to_string()
    } else if path.is_empty() {
        format!("/{resource}")
    } else {
        format!("{path}/{resource}")
    };
    url.set_path(&endpoint);
    Ok(url)
}

pub fn ai_chat_completions_url(base_url: &str) -> Result<Url, String> {
    ai_resource_url(base_url, "chat/completions")
}

pub fn ai_messages_url(base_url: &str) -> Result<Url, String> {
    ai_resource_url(base_url, "messages")
}

pub fn ai_chat_endpoint(base_url: &str, api_format: &str) -> Result<Url, String> {
    if is_claude_api_format(api_format) {
        ai_messages_url(base_url)
    } else {
        ai_chat_completions_url(base_url)
    }
}

pub fn ai_models_url(base_url: &str) -> Result<Url, String> {
    ai_resource_url(base_url, "models")
}

fn default_ai_reasoning_effort() -> String {
    DEFAULT_AI_REASONING_EFFORT.to_string()
}

fn default_ai_api_format() -> String {
    DEFAULT_AI_API_FORMAT.to_string()
}

fn default_ai_context_window() -> u32 {
    DEFAULT_AI_CONTEXT_WINDOW
}

fn default_ai_max_tokens() -> u32 {
    DEFAULT_AI_MAX_TOKENS
}

fn default_ai_account_name() -> String {
    "默认".to_string()
}

/// 单个供应商账号（接口地址 + 密钥 + 模型目录）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderAccountStore {
    pub id: String,
    #[serde(default = "default_ai_account_name")]
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub enabled_models: Vec<String>,
    #[serde(default = "default_ai_api_format")]
    pub api_format: String,
    /// 模型上下文窗口（token），用于上下文用量预算
    #[serde(default = "default_ai_context_window")]
    pub context_window: u32,
    /// 最大输出 token；0 = 不限制
    #[serde(default = "default_ai_max_tokens")]
    pub max_tokens: u32,
    pub use_api_key: bool,
    pub api_key_secret_id: Option<String>,
}

pub fn new_default_ai_account() -> AiProviderAccountStore {
    AiProviderAccountStore {
        id: "default".to_string(),
        name: default_ai_account_name(),
        base_url: DEFAULT_AI_BASE_URL.to_string(),
        model: DEFAULT_AI_MODEL.to_string(),
        models: vec![DEFAULT_AI_MODEL.to_string()],
        enabled_models: vec![DEFAULT_AI_MODEL.to_string()],
        api_format: DEFAULT_AI_API_FORMAT.to_string(),
        context_window: DEFAULT_AI_CONTEXT_WINDOW,
        max_tokens: DEFAULT_AI_MAX_TOKENS,
        use_api_key: true,
        api_key_secret_id: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderConfigStore {
    pub version: u8,
    pub active_account_id: String,
    pub accounts: Vec<AiProviderAccountStore>,
    /// 全局推理强度（跨账号）
    #[serde(default = "default_ai_reasoning_effort")]
    pub reasoning_effort: String,
}

impl Default for AiProviderConfigStore {
    fn default() -> Self {
        let account = new_default_ai_account();
        Self {
            version: AI_CONFIG_VERSION,
            active_account_id: account.id.clone(),
            accounts: vec![account],
            reasoning_effort: DEFAULT_AI_REASONING_EFFORT.to_string(),
        }
    }
}

pub fn load_ai_config() -> Result<AiProviderConfigStore, String> {
    let path = ai_config_path()?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AiProviderConfigStore::default());
        }
        Err(error) => return Err(format!("AI 供应商配置读取失败：{error}")),
    };
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("AI 供应商配置已损坏，已拒绝加载原文件：{error}"))?;
    let mut config = if value
        .get("accounts")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        serde_json::from_value::<AiProviderConfigStore>(value)
            .map_err(|error| format!("AI 供应商配置已损坏，已拒绝加载原文件：{error}"))?
    } else {
        migrate_ai_config_v1(value)?
    };
    normalize_ai_config_store(&mut config)?;
    Ok(config)
}

/// v1 扁平结构 → 多账号
pub fn migrate_ai_config_v1(value: Value) -> Result<AiProviderConfigStore, String> {
    let base_url = value
        .get("base_url")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_AI_BASE_URL)
        .to_string();
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_AI_MODEL)
        .to_string();
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![model.clone()]);
    let enabled_models = value
        .get("enabled_models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| models.clone());
    let reasoning_effort = value
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_AI_REASONING_EFFORT)
        .to_string();
    let api_format = value
        .get("api_format")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_AI_API_FORMAT)
        .to_string();
    let use_api_key = value
        .get("use_api_key")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let api_key_secret_id = value
        .get("api_key_secret_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let account = AiProviderAccountStore {
        id: "default".to_string(),
        name: default_ai_account_name(),
        base_url,
        model,
        models,
        enabled_models,
        api_format,
        context_window: DEFAULT_AI_CONTEXT_WINDOW,
        max_tokens: DEFAULT_AI_MAX_TOKENS,
        use_api_key,
        api_key_secret_id,
    };
    Ok(AiProviderConfigStore {
        version: AI_CONFIG_VERSION,
        active_account_id: account.id.clone(),
        accounts: vec![account],
        reasoning_effort,
    })
}

pub fn normalize_ai_config_store(config: &mut AiProviderConfigStore) -> Result<(), String> {
    if config.accounts.is_empty() {
        *config = AiProviderConfigStore::default();
        return Ok(());
    }
    if config.accounts.len() > MAX_AI_ACCOUNTS {
        return Err(format!("AI 账号数量不能超过 {MAX_AI_ACCOUNTS}"));
    }
    let mut seen = HashSet::new();
    for account in &mut config.accounts {
        account.id = account.id.trim().to_string();
        if account.id.is_empty() {
            account.id = Uuid::new_v4().to_string();
        }
        if !seen.insert(account.id.clone()) {
            return Err(format!("AI 账号 id 重复：{}", account.id));
        }
        account.name = normalize_ai_account_name(&account.name);
        validate_ai_base_url(&account.base_url)?;
        account.model = validate_ai_model(&account.model)?;
        account.models = normalize_ai_models(&account.models, &account.model)?;
        account.enabled_models =
            normalize_enabled_ai_models(&account.models, &account.enabled_models, &account.model)?;
        account.api_format = validate_ai_api_format(&account.api_format)?;
        account.context_window = validate_ai_context_window(account.context_window)?;
        account.max_tokens = validate_ai_max_tokens(account.max_tokens)?;
    }
    if !config
        .accounts
        .iter()
        .any(|item| item.id == config.active_account_id)
    {
        config.active_account_id = config.accounts[0].id.clone();
    }
    config.reasoning_effort = validate_ai_reasoning_effort(&config.reasoning_effort)?;
    config.version = AI_CONFIG_VERSION;
    Ok(())
}

pub fn normalize_ai_account_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return default_ai_account_name();
    }
    name.chars().take(64).collect()
}

pub fn find_ai_account<'a>(
    config: &'a AiProviderConfigStore,
    account_id: Option<&str>,
) -> Result<&'a AiProviderAccountStore, String> {
    let id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.active_account_id.as_str());
    config
        .accounts
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("未找到 AI 账号：{id}"))
}

pub fn find_ai_account_mut<'a>(
    config: &'a mut AiProviderConfigStore,
    account_id: Option<&str>,
) -> Result<&'a mut AiProviderAccountStore, String> {
    let id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.active_account_id.as_str())
        .to_string();
    config
        .accounts
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("未找到 AI 账号：{id}"))
}

pub fn save_ai_config(config: &AiProviderConfigStore) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("AI 供应商配置序列化失败：{error}"))?;
    atomic_write_text(&ai_config_path()?, &content)
        .map_err(|error| format!("AI 供应商配置保存失败：{error}"))
}