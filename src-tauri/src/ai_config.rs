use std::collections::HashSet;

use reqwest::Url;

pub const MAX_AI_MODELS: usize = 500;

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