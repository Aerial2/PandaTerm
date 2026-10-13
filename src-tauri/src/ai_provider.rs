//! Unified AI provider protocol, payload, tool and stream parsing.
//!
//! This module deliberately owns wire-format concerns so commands only need to
//! translate provider events into the existing Tauri event envelope.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const CLAUDE_FALLBACK_MAX_TOKENS: u32 = crate::ai_config::AI_CLAUDE_FALLBACK_MAX_TOKENS;
pub const MAX_SSE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
pub const MAX_TOOL_CALLS: usize = 32;
pub const MAX_TOOL_ARGUMENT_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAi,
    Claude,
}

impl ProviderKind {
    pub fn parse(format: &str) -> Result<Self, String> {
        match format.trim().to_ascii_lowercase().as_str() {
            "openai" => Ok(Self::OpenAi),
            "claude" | "anthropic" => Ok(Self::Claude),
            _ => Err("接口兼容格式无效，可选：openai / claude".to_string()),
        }
    }

    pub fn is_claude(self) -> bool {
        matches!(self, Self::Claude)
    }

    /// Wire-format capabilities, not a claim about a particular model/account.
    #[cfg(test)]
    pub fn capabilities(self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_calls: true,
            usage: true,
            reasoning_effort: if self.is_claude() { Some(false) } else { None },
            vision: None,
        }
    }
}

/// `None` means model/account support has not been established. Protocol support
/// alone must never be used to promise that a particular provider enables it.
#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub tool_calls: bool,
    pub usage: bool,
    pub reasoning_effort: Option<bool>,
    pub vision: Option<bool>,
}

#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderModel {
    pub id: String,
    pub provider_id: String,
    pub account_id: String,
    pub model: String,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub context_window: u32,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub capabilities: ProviderCapabilities,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderResponse {
    pub content: String,
    pub model: Option<String>,
    pub usage: Option<Usage>,
    pub tool_calls: Vec<UnifiedToolCall>,
    /// Cancellation returns partial text/usage, without authorizing partial tools.
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnifiedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<UnifiedToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

impl ProviderEvent {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            delta: None,
            model: None,
            usage: None,
            tool_calls: None,
            error: None,
            cancelled: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct ToolAccumulator {
    calls: BTreeMap<usize, UnifiedToolCall>,
    fallback_ids: BTreeMap<usize, String>,
    claude_initial_inputs: BTreeMap<usize, String>,
}

impl ToolAccumulator {
    pub fn apply_openai(
        &mut self,
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        arguments: Option<&str>,
    ) -> Result<(), String> {
        if index >= MAX_TOOL_CALLS {
            return Err(format!("工具调用数量不能超过 {MAX_TOOL_CALLS}"));
        }
        self.fallback_ids
            .entry(index)
            .or_insert_with(|| format!("call_{}", uuid::Uuid::new_v4()));
        let call = self.calls.entry(index).or_insert_with(|| UnifiedToolCall {
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        if let Some(id) = id.filter(|s| !s.is_empty()) {
            if !call.id.is_empty() && call.id != id {
                return Err("工具调用 id 在流中发生变化".into());
            }
            call.id = id.to_string();
        }
        if let Some(name) = name.filter(|s| !s.is_empty()) {
            if !call.name.is_empty() && call.name != name {
                return Err("工具调用名称在流中发生变化".into());
            }
            call.name = name.to_string();
        }
        if let Some(arguments) = arguments {
            if call.arguments.len().saturating_add(arguments.len()) > MAX_TOOL_ARGUMENT_CHARS {
                return Err(format!("工具参数不能超过 {MAX_TOOL_ARGUMENT_CHARS} 个字符"));
            }
            call.arguments.push_str(arguments);
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<Vec<UnifiedToolCall>, String> {
        let mut result = Vec::with_capacity(self.calls.len());
        let mut ids = BTreeSet::new();
        for (index, existing) in &self.calls {
            let mut call = existing.clone();
            validate_tool_name(&call.name)?;
            if call.id.trim().is_empty() {
                call.id = self
                    .fallback_ids
                    .get(index)
                    .cloned()
                    .ok_or("工具调用缺少 id")?;
            }
            crate::ai_tools::validate_tool_call_id(&call.id)?;
            if !ids.insert(call.id.clone()) {
                return Err("工具调用 id 重复".into());
            }
            if call.arguments.is_empty() {
                call.arguments = self
                    .claude_initial_inputs
                    .get(index)
                    .cloned()
                    .ok_or("工具调用缺少参数 JSON")?;
            }
            validate_tool_arguments(&call.arguments)?;
            result.push(call);
        }
        Ok(result)
    }
}

/// The one registry used by both OpenAI-compatible and Claude requests.
pub fn tool_specs() -> Vec<Value> {
    crate::ai_tools::openai_specs()
}

pub fn openai_tools() -> Vec<Value> {
    tool_specs()
}

#[cfg(test)]
pub fn claude_tools() -> Vec<Value> {
    claude_tools_from_openai(&tool_specs())
}

pub fn apply_auth(builder: RequestBuilder, format: &str, api_key: Option<&str>) -> RequestBuilder {
    let key = api_key.filter(|value| !value.is_empty());
    if matches!(ProviderKind::parse(format), Ok(ProviderKind::Claude)) {
        let builder = builder.header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(key) = key {
            builder.header("x-api-key", key)
        } else {
            builder
        }
    } else if let Some(key) = key {
        builder.bearer_auth(key)
    } else {
        builder
    }
}

fn validate_tool_name(name: &str) -> Result<(), String> {
    if crate::ai_tools::find(name).is_none() {
        return Err(format!("未注册的 Agent 工具：{name}"));
    }
    Ok(())
}

fn validate_tool_arguments(arguments: &str) -> Result<Value, String> {
    if arguments.len() > MAX_TOOL_ARGUMENT_CHARS {
        return Err(format!("工具参数不能超过 {MAX_TOOL_ARGUMENT_CHARS} 个字节"));
    }
    let value: Value = serde_json::from_str(arguments)
        .map_err(|e| format!("工具调用参数 JSON 不完整或无效：{e}"))?;
    if !value.is_object() {
        return Err("工具调用参数必须是 JSON 对象".into());
    }
    Ok(value)
}

/// Text content may be a string or OpenAI/Claude text-block array.
fn text_content(content: Option<&Value>) -> Result<String, String> {
    match content {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Array(blocks)) => {
            let mut text = String::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text" | "output_text") => text.push_str(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or("文本块缺少 text")?,
                    ),
                    _ => return Err("不支持的文本 content 块格式".into()),
                }
            }
            Ok(text)
        }
        _ => Err("content 必须是字符串或文本块数组".into()),
    }
}

fn validate_messages(messages: &[Value]) -> Result<(), String> {
    if messages.is_empty() {
        return Err("AI 请求缺少消息".into());
    }
    let mut declared_calls = BTreeSet::new();
    let mut pending_calls = BTreeSet::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or("消息缺少 role")?;
        if !matches!(role, "system" | "user" | "assistant" | "tool") {
            return Err(format!("不支持消息角色：{role}"));
        }
        if role != "tool" && !pending_calls.is_empty() {
            return Err("工具调用结果必须紧跟在对应的 assistant 工具调用之后".into());
        }
        text_content(message.get("content"))?;
        if let Some(calls) = message.get("tool_calls") {
            if role != "assistant" {
                return Err("只有 assistant 消息可以包含 tool_calls".into());
            }
            let calls = calls.as_array().ok_or("tool_calls 必须是数组")?;
            if calls.len() > MAX_TOOL_CALLS {
                return Err("工具调用数量超限".into());
            }
            for call in calls {
                if call.get("type").and_then(Value::as_str) != Some("function") {
                    return Err("工具调用 type 必须是 function".into());
                }
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("工具调用缺少 id")?;
                crate::ai_tools::validate_tool_call_id(id)?;
                if !declared_calls.insert(id) {
                    return Err("工具调用 id 重复".into());
                }
                pending_calls.insert(id.to_string());
                validate_tool_name(
                    call.pointer("/function/name")
                        .and_then(Value::as_str)
                        .ok_or("工具调用缺少名称")?,
                )?;
                validate_tool_arguments(
                    call.pointer("/function/arguments")
                        .and_then(Value::as_str)
                        .ok_or("工具调用缺少参数")?,
                )?;
            }
        }
        if role == "tool" {
            let id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .ok_or("tool 消息缺少 tool_call_id")?;
            crate::ai_tools::validate_tool_call_id(id)?;
            if !pending_calls.remove(id) {
                return Err(format!("tool 消息没有对应的未完成工具调用：{id}"));
            }
        }
    }
    if !pending_calls.is_empty() {
        return Err("存在未返回结果的工具调用".into());
    }
    Ok(())
}

pub fn build_payload(
    kind: ProviderKind,
    model: &str,
    messages: &[Value],
    stream: bool,
    max_tokens: u32,
    reasoning_effort: Option<&str>,
    agent_mode: bool,
) -> Result<Value, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".into());
    }
    validate_messages(messages)?;
    if kind.is_claude() {
        if reasoning_effort.is_some() {
            return Err("Claude Messages 协议不支持 reasoning_effort 字段".into());
        }
        let tools = agent_mode.then(tool_specs);
        return build_claude_payload(model, messages, stream, max_tokens, tools.as_deref());
    }
    let mut payload = json!({"model":model,"messages":messages,"stream":stream});
    if stream {
        payload["stream_options"] = json!({"include_usage":true});
    }
    if max_tokens > 0 {
        payload["max_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = reasoning_effort {
        if !matches!(
            effort,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        ) {
            return Err("reasoning_effort 值无效".into());
        }
        payload["reasoning_effort"] = json!(effort);
    }
    if agent_mode {
        payload["tools"] = json!(openai_tools());
    }
    Ok(payload)
}

/// Build Anthropic Messages payload from normalized JSON messages.
pub fn build_claude_payload(
    model: &str,
    messages: &[Value],
    stream: bool,
    max_tokens: u32,
    tools: Option<&[Value]>,
) -> Result<Value, String> {
    validate_messages(messages)?;
    let mut system = Vec::new();
    let mut output: Vec<Value> = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        match role.as_str() {
            "system" => {
                let content = text_content(message.get("content"))?;
                if !content.trim().is_empty() {
                    system.push(content);
                }
            }
            "user" | "assistant" => {
                let mut blocks = Vec::new();
                let content = text_content(message.get("content"))?;
                if !content.is_empty() {
                    blocks.push(json!({"type":"text","text":content}));
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    if calls.len() > MAX_TOOL_CALLS {
                        return Err(format!("工具调用数量不能超过 {MAX_TOOL_CALLS}"));
                    }
                    for call in calls {
                        let id = call
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| "tool_calls 缺少 id".to_string())?;
                        let function = call
                            .get("function")
                            .ok_or_else(|| "tool_calls 缺少 function".to_string())?;
                        let name = function
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| "tool_calls 缺少 function.name".to_string())?;
                        let args = function
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        if args.len() > MAX_TOOL_ARGUMENT_CHARS {
                            return Err(format!(
                                "工具参数不能超过 {MAX_TOOL_ARGUMENT_CHARS} 个字符"
                            ));
                        }
                        let input: Value = serde_json::from_str(args)
                            .map_err(|e| format!("工具参数 JSON 无效：{e}"))?;
                        blocks.push(json!({"type":"tool_use","id":id,"name":name,"input":input}));
                    }
                }
                if !blocks.is_empty() {
                    append_content(&mut output, &role, blocks);
                }
            }
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "tool 消息缺少 tool_call_id".to_string())?;
                let content = text_content(message.get("content"))?;
                if content.len() > MAX_TOOL_ARGUMENT_CHARS {
                    return Err(format!("工具结果不能超过 {MAX_TOOL_ARGUMENT_CHARS} 个字符"));
                }
                append_content(
                    &mut output,
                    "user",
                    vec![json!({"type":"tool_result","tool_use_id":id,"content":content})],
                );
            }
            _ => return Err(format!("Claude 格式不支持消息角色：{role}")),
        }
    }
    if output.is_empty() {
        return Err("Claude 请求缺少 user/assistant 消息".to_string());
    }
    if output
        .first()
        .and_then(|v| v.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        output.insert(0, json!({"role":"user","content":"(continue)"}));
    }
    let mut payload = json!({"model": model, "max_tokens": if max_tokens == 0 { CLAUDE_FALLBACK_MAX_TOKENS } else { max_tokens }, "stream": stream, "messages": output});
    if !system.is_empty() {
        payload["system"] = Value::String(system.join("\n\n"));
    }
    if let Some(tools) = tools.filter(|t| !t.is_empty()) {
        payload["tools"] = Value::Array(claude_tools_from_openai(tools));
    }
    Ok(payload)
}

fn append_content(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({"role":role,"content":blocks}));
}

fn claude_tools_from_openai(tools: &[Value]) -> Vec<Value> {
    tools.iter().filter_map(|tool| {
        let f = tool.get("function")?;
        Some(json!({"name": f.get("name")?, "description": f.get("description").cloned().unwrap_or(Value::Null), "input_schema": f.get("parameters")?}))
    }).collect()
}

fn validate_usage(value: Option<&Value>, fields: &[&str]) -> Result<(), String> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    if !value.is_object() {
        return Err("usage 必须是 JSON 对象".into());
    }
    for field in fields {
        if let Some(count) = value.get(*field) {
            if count.as_u64().is_none() {
                return Err(format!("usage.{field} 必须是非负整数"));
            }
        }
    }
    Ok(())
}

fn validate_provider_usage(kind: ProviderKind, value: &Value) -> Result<(), String> {
    if kind.is_claude() {
        let fields = [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ];
        validate_usage(value.pointer("/message/usage"), &fields)?;
        validate_usage(value.get("usage"), &fields)
    } else {
        validate_usage(
            value.get("usage"),
            &["prompt_tokens", "completion_tokens", "total_tokens"],
        )?;
        validate_usage(
            value.pointer("/usage/prompt_tokens_details"),
            &["cached_tokens"],
        )
    }
}

pub fn parse_claude_event(data: &str, acc: &mut ToolAccumulator) -> Result<ProviderEvent, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|e| format!("Claude 流式响应格式不兼容：{e}"))?;
    validate_provider_usage(ProviderKind::Claude, &value)?;
    let typ = value.get("type").and_then(Value::as_str).unwrap_or("");
    let mut event = ProviderEvent::new("ignored");
    match typ {
        "message_start" => {
            if !value.get("message").is_some_and(Value::is_object) {
                return Err("Claude message_start 缺少 message 对象".into());
            }
            event.kind = "started".to_string();
            event.model = value
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            event.usage = usage_from_claude(value.pointer("/message/usage"));
            let text = text_content(value.pointer("/message/content"))?;
            if !text.is_empty() {
                event.delta = Some(text);
            }
        }
        "content_block_delta" => match value
            .pointer("/delta/type")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "text_delta" => {
                event.kind = "delta".to_string();
                event.delta = Some(
                    value
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .ok_or("Claude text_delta 缺少 text")?
                        .into(),
                );
            }
            "input_json_delta" => {
                let partial = value
                    .pointer("/delta/partial_json")
                    .and_then(Value::as_str)
                    .ok_or("Claude input_json_delta 缺少 partial_json")?;
                let index = event_index(&value)?;
                if !acc.calls.contains_key(&index) {
                    return Err("Claude 工具 delta 缺少开始事件".into());
                }
                acc.apply_openai(index, None, None, Some(partial))?;
                event.kind = "tool_delta".to_string();
            }
            "thinking_delta" | "signature_delta" => {}
            typ => return Err(format!("Claude delta 类型未知：{typ}")),
        },
        "content_block_start" => {
            let block = value
                .get("content_block")
                .ok_or("Claude content_block_start 缺少 content_block")?;
            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let index = event_index(&value)?;
                    if acc.calls.contains_key(&index) {
                        return Err("Claude content block index 重复".into());
                    }
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    let arguments = serde_json::to_string(&input).map_err(|e| e.to_string())?;
                    validate_tool_arguments(&arguments)?;
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or("Claude tool_use 缺少 name")?;
                    validate_tool_name(name)?;
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or("Claude tool_use 缺少 id")?;
                    crate::ai_tools::validate_tool_call_id(id)?;
                    acc.apply_openai(index, Some(id), Some(name), None)?;
                    acc.claude_initial_inputs.insert(index, arguments);
                    event.kind = "tool_delta".to_string();
                }
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or("Claude text block 缺少 text")?;
                    if !text.is_empty() {
                        event.kind = "delta".into();
                        event.delta = Some(text.into());
                    }
                }
                Some("thinking" | "redacted_thinking") => {}
                _ => return Err("Claude content block 类型未知".into()),
            }
        }
        "message_delta" => {
            event.kind = "usage".to_string();
            event.usage = usage_from_claude(value.pointer("/usage"));
        }
        "message_stop" => {
            event.kind = "completed".to_string();
            event.tool_calls = Some(acc.finish()?);
        }
        "error" => {
            event.kind = "error".to_string();
            event.error = Some(
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude 流式错误")
                    .to_string(),
            );
        }
        "ping" | "content_block_stop" => {}
        _ => return Err(format!("Claude 流式响应事件类型未知：{typ}")),
    }
    if event.usage.is_none() {
        event.usage = usage_from_claude(value.get("usage"));
    }
    Ok(event)
}

fn event_index(value: &Value) -> Result<usize, String> {
    let index = value
        .get("index")
        .and_then(Value::as_u64)
        .ok_or("工具 delta 缺少有效 index")?;
    usize::try_from(index).map_err(|_| "工具 delta index 超限".into())
}

fn usage_from_claude(value: Option<&Value>) -> Option<Usage> {
    let v = value?;
    let input = v.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
    let output = v.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = v.get("cache_read_input_tokens").and_then(Value::as_u64);
    let cache_write = v.get("cache_creation_input_tokens").and_then(Value::as_u64);
    if !v.is_object() {
        return None;
    }
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input
            .saturating_add(output)
            .saturating_add(cache_read.unwrap_or(0))
            .saturating_add(cache_write.unwrap_or(0)),
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
    })
}

fn usage_from_openai(value: Option<&Value>) -> Option<Usage> {
    let value = value?.as_object()?;
    let input = value
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = value
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| input.saturating_add(output)),
        cache_read_tokens: value
            .get("prompt_tokens_details")
            .and_then(|v| v.get("cached_tokens"))
            .and_then(Value::as_u64),
        cache_write_tokens: None,
    })
}

fn response_error(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("error") && value.get("error").is_none() {
        return Some(
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("供应商返回错误")
                .to_string(),
        );
    }
    value.get("error").filter(|v| !v.is_null()).map(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
            .unwrap_or("供应商返回错误")
            .to_string()
    })
}

pub fn parse_openai_event(data: &str, acc: &mut ToolAccumulator) -> Result<ProviderEvent, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|e| format!("OpenAI 流式响应格式不兼容：{e}"))?;
    let mut event = ProviderEvent::new("ignored");
    if let Some(error) = response_error(&value) {
        event.kind = "error".into();
        event.error = Some(error);
        return Ok(event);
    }
    validate_provider_usage(ProviderKind::OpenAi, &value)?;
    event.model = value
        .get("model")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    event.usage = usage_from_openai(value.get("usage"));
    if event.usage.is_some() {
        event.kind = "usage".into();
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .ok_or("OpenAI 流式响应缺少 choices 数组")?;
    if choices.len() > 1 {
        return Err("统一响应仅支持单个 choice".into());
    }
    if choices.is_empty() && event.usage.is_none() {
        return Err("OpenAI 空 choices 缺少 usage".into());
    }
    for choice in choices {
        let delta = choice
            .get("delta")
            .filter(|v| v.is_object())
            .ok_or("OpenAI 流式 choice 缺少 delta 对象")?;
        let text = text_content(delta.get("content"))?;
        if !text.is_empty() {
            event.kind = "delta".into();
            event.delta = Some(text);
        }
        if let Some(tool_calls) = delta.get("tool_calls") {
            for tool in tool_calls.as_array().ok_or("tool_calls 必须是数组")? {
                if let Some(kind) = tool.get("type") {
                    if kind.as_str() != Some("function") {
                        return Err("未知工具调用类型".into());
                    }
                }
                let index = event_index(tool)?;
                acc.apply_openai(
                    index,
                    tool.get("id").and_then(Value::as_str),
                    tool.pointer("/function/name").and_then(Value::as_str),
                    tool.pointer("/function/arguments").and_then(Value::as_str),
                )?;
                event.kind = "tool_delta".into();
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !matches!(reason, "stop" | "length" | "tool_calls" | "content_filter") {
                return Err(format!("OpenAI finish_reason 未知：{reason}"));
            }
            // Legacy parser contract. Transport suppresses this callback and keeps
            // reading until [DONE]/EOF so the final usage chunk cannot be lost.
            event.kind = "completed".into();
            event.tool_calls = Some(acc.finish()?);
        }
    }
    Ok(event)
}

pub fn parse_response(kind: ProviderKind, body: &str) -> Result<ProviderResponse, String> {
    let value: Value = serde_json::from_str(body).map_err(|e| format!("AI 响应 JSON 无效：{e}"))?;
    if let Some(error) = response_error(&value) {
        return Err(error);
    }
    validate_provider_usage(kind, &value)?;
    let mut response = ProviderResponse {
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        ..ProviderResponse::default()
    };
    let mut acc = ToolAccumulator::default();
    match kind {
        ProviderKind::OpenAi => {
            let choices = value
                .get("choices")
                .and_then(Value::as_array)
                .ok_or("OpenAI 响应缺少 choices")?;
            if choices.len() != 1 {
                return Err("OpenAI 响应必须包含单个 choice".into());
            }
            let message = choices[0]
                .get("message")
                .filter(|v| v.is_object())
                .ok_or("OpenAI 响应缺少 message")?;
            response.content = text_content(message.get("content"))?;
            if let Some(calls) = message.get("tool_calls") {
                for (index, call) in calls
                    .as_array()
                    .ok_or("tool_calls 必须是数组")?
                    .iter()
                    .enumerate()
                {
                    if call.get("type").and_then(Value::as_str) != Some("function") {
                        return Err("未知工具调用类型".into());
                    }
                    acc.apply_openai(
                        index,
                        call.get("id").and_then(Value::as_str),
                        call.pointer("/function/name").and_then(Value::as_str),
                        Some(
                            call.pointer("/function/arguments")
                                .and_then(Value::as_str)
                                .ok_or("工具调用缺少参数")?,
                        ),
                    )?;
                }
            }
            response.usage = usage_from_openai(value.get("usage"));
        }
        ProviderKind::Claude => {
            if value.get("type").and_then(Value::as_str) != Some("message") {
                return Err("Claude 响应 type 必须是 message".into());
            }
            let blocks = value
                .get("content")
                .and_then(Value::as_array)
                .ok_or("Claude 响应缺少 content 数组")?;
            let mut tool_index = 0;
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => response.content.push_str(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or("Claude 文本块缺少 text")?,
                    ),
                    Some("tool_use") => {
                        let input = block.get("input").ok_or("Claude tool_use 缺少 input")?;
                        let arguments = input.to_string();
                        validate_tool_arguments(&arguments)?;
                        acc.apply_openai(
                            tool_index,
                            block.get("id").and_then(Value::as_str),
                            block.get("name").and_then(Value::as_str),
                            Some(&arguments),
                        )?;
                        tool_index += 1;
                    }
                    Some("thinking" | "redacted_thinking") => {}
                    _ => return Err("Claude 响应 content 块类型未知".into()),
                }
            }
            response.usage = usage_from_claude(value.get("usage"));
        }
    }
    response.tool_calls = acc.finish()?;
    Ok(response)
}

#[derive(Debug)]
struct SseFrame {
    event: Option<String>,
    data: String,
}

/// Byte-oriented decoding preserves split UTF-8 and CRLF boundaries. Bounds
/// apply to one unfinished event, not the entire (potentially long) response.
#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: Vec<String>,
    event: Option<String>,
    event_bytes: usize,
    skip_lf: bool,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, String> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    if self.event_bytes != 0 {
                        self.event_bytes = self.event_bytes.saturating_add(1);
                        if self.event_bytes > MAX_SSE_EVENT_BYTES {
                            return Err("SSE 事件超过 2 MiB 限制".into());
                        }
                    }
                    continue;
                }
            }
            self.event_bytes = self.event_bytes.saturating_add(1);
            if self.event_bytes > MAX_SSE_EVENT_BYTES {
                return Err("SSE 事件超过 2 MiB 限制".into());
            }
            if byte == b'\r' || byte == b'\n' {
                self.skip_lf = byte == b'\r';
                if self.line.is_empty() {
                    if !self.data.is_empty() {
                        frames.push(SseFrame {
                            event: self.event.take(),
                            data: self.data.join("\n"),
                        });
                    }
                    self.data.clear();
                    self.event = None;
                    self.event_bytes = 0;
                } else {
                    let line =
                        std::str::from_utf8(&self.line).map_err(|_| "SSE 响应不是有效 UTF-8")?;
                    if !line.starts_with(':') {
                        let (field, value) = line.split_once(':').unwrap_or((line, ""));
                        let value = value.strip_prefix(' ').unwrap_or(value);
                        match field {
                            "data" => self.data.push(value.to_string()),
                            "event" => self.event = Some(value.to_string()),
                            // Per the SSE specification these fields do not carry
                            // provider payload; unknown extension fields are ignored.
                            _ => {}
                        }
                    }
                    self.line.clear();
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(frames)
    }

    fn pending_bytes(&self) -> usize {
        self.event_bytes
    }
}

pub(crate) fn merge_claude_usage(usage: &mut Option<Usage>, value: &Value) {
    let Some(value) = value
        .pointer("/message/usage")
        .or_else(|| value.get("usage"))
        .filter(|v| v.is_object())
    else {
        return;
    };
    let usage = usage.get_or_insert_with(Usage::default);
    // Anthropic sends cumulative output counts, not increments. A delta which
    // omits input/cache counts must retain the counts from message_start.
    if let Some(input) = value.get("input_tokens").and_then(Value::as_u64) {
        usage.input_tokens = input;
    }
    if let Some(output) = value.get("output_tokens").and_then(Value::as_u64) {
        usage.output_tokens = output;
    }
    if let Some(cache) = value.get("cache_read_input_tokens").and_then(Value::as_u64) {
        usage.cache_read_tokens = Some(cache);
    }
    if let Some(cache) = value
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
    {
        usage.cache_write_tokens = Some(cache);
    }
    usage.total_tokens = usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cache_read_tokens.unwrap_or(0))
        .saturating_add(usage.cache_write_tokens.unwrap_or(0));
}

fn finish_stream(
    mut response: ProviderResponse,
    cancelled: bool,
    acc: &ToolAccumulator,
    on_event: &mut impl FnMut(ProviderEvent),
) -> Result<ProviderResponse, String> {
    response.cancelled = cancelled;
    response.tool_calls = if cancelled { Vec::new() } else { acc.finish()? };
    let mut event = ProviderEvent::new("completed");
    event.model = response.model.clone();
    event.usage = response.usage.clone();
    event.tool_calls = Some(response.tool_calls.clone());
    event.cancelled = Some(cancelled);
    on_event(event);
    Ok(response)
}

async fn bounded_error_body(
    response: &mut reqwest::Response,
    cancellation: &crate::ai_tools::Cancellation,
) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let deadline = tokio::time::Instant::now() + HEADER_TIMEOUT;
    while bytes.len() < MAX_ERROR_BODY_BYTES {
        let chunk = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(None),
            result = tokio::time::timeout_at(deadline, response.chunk()) => {
                match result {
                    Ok(Ok(chunk)) => chunk,
                    // Preserve HTTP status even if the error body is incomplete.
                    _ => break,
                }
            }
        };
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let Some(chunk) = chunk else {
            break;
        };
        bytes.extend_from_slice(&chunk[..chunk.len().min(MAX_ERROR_BODY_BYTES - bytes.len())]);
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Sends a streaming request. Errors are returned to the caller (never emitted),
/// successful/cancelled requests emit exactly one final completed event.
pub async fn stream_request(
    builder: reqwest::RequestBuilder,
    kind: ProviderKind,
    cancellation: Arc<crate::ai_tools::Cancellation>,
    mut on_event: impl FnMut(ProviderEvent),
) -> Result<ProviderResponse, String> {
    let mut response = ProviderResponse::default();
    let mut acc = ToolAccumulator::default();
    if cancellation.is_cancelled() {
        return finish_stream(response, true, &acc, &mut on_event);
    }
    let mut http = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return finish_stream(response, true, &acc, &mut on_event),
        result = tokio::time::timeout(HEADER_TIMEOUT, builder.send()) => {
            result.map_err(|_| "AI 请求响应头超时（120 秒）".to_string())?
                .map_err(|error| format!("AI 请求发送失败：{}", error.without_url()))?
        }
    };
    if cancellation.is_cancelled() {
        return finish_stream(response, true, &acc, &mut on_event);
    }
    if !http.status().is_success() {
        let status = http.status();
        let Some(body) = bounded_error_body(&mut http, &cancellation).await? else {
            return finish_stream(response, true, &acc, &mut on_event);
        };
        if cancellation.is_cancelled() {
            return finish_stream(response, true, &acc, &mut on_event);
        }
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| response_error(&value))
            .unwrap_or_else(|| {
                // HTML/other server bodies are bounded too; omit request URL/headers.
                body.trim().to_string()
            });
        return Err(format!("AI HTTP 错误 {status}：{detail}"));
    }
    let content_type = http
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/event-stream")
    {
        return Err("AI 流式响应 Content-Type 必须为 text/event-stream".into());
    }
    let mut decoder = SseDecoder::default();
    let mut finished = false;
    let mut claude_started = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return finish_stream(response, true, &acc, &mut on_event),
            result = tokio::time::timeout(IDLE_TIMEOUT, http.chunk()) => {
                result.map_err(|_| "AI 流式响应空闲超时（180 秒）".to_string())?
                    .map_err(|error| format!("AI 流式响应读取失败：{}", error.without_url()))?
            }
        };
        if cancellation.is_cancelled() {
            return finish_stream(response, true, &acc, &mut on_event);
        }
        let Some(chunk) = chunk else {
            ensure_complete(finished, false, decoder.pending_bytes())?;
            return finish_stream(response, false, &acc, &mut on_event);
        };
        // Decode one wire line at a time so a terminal marker is handled before
        // any unrelated bytes which happen to share the same HTTP chunk.
        for segment in chunk.split_inclusive(|byte| matches!(*byte, b'\r' | b'\n')) {
            for frame in decoder.push(segment)? {
                if cancellation.is_cancelled() {
                    return finish_stream(response, true, &acc, &mut on_event);
                }
                if frame.data.trim() == "[DONE]" {
                    if kind.is_claude() {
                        return Err("Claude 协议不支持 [DONE] 结束标记".into());
                    }
                    if frame
                        .event
                        .as_deref()
                        .is_some_and(|name| !name.is_empty() && name != "message")
                    {
                        return Err("[DONE] 不能携带未知或错误 SSE event".into());
                    }
                    return finish_stream(
                        response,
                        cancellation.is_cancelled(),
                        &acc,
                        &mut on_event,
                    );
                }
                let value: Value = serde_json::from_str(&frame.data)
                    .map_err(|e| format!("SSE 数据 JSON 无效：{e}"))?;
                if let Some(name) = frame.event.as_deref().filter(|name| !name.is_empty()) {
                    match kind {
                        ProviderKind::OpenAi if !matches!(name, "message" | "error") => {
                            return Err(format!("OpenAI SSE 事件未知：{name}"))
                        }
                        ProviderKind::OpenAi if name == "error" => {
                            return Err(response_error(&value)
                                .or_else(|| {
                                    value
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .map(ToString::to_string)
                                })
                                .unwrap_or_else(|| "供应商流式错误".into()))
                        }
                        ProviderKind::Claude
                            if value.get("type").and_then(Value::as_str) != Some(name) =>
                        {
                            return Err("Claude SSE event 与 JSON type 不一致".into())
                        }
                        _ => {}
                    }
                }
                if kind.is_claude() {
                    match value.get("type").and_then(Value::as_str) {
                        Some("message_start") => {
                            if claude_started {
                                return Err("Claude message_start 重复".into());
                            }
                            claude_started = true;
                        }
                        Some("ping" | "error") => {}
                        _ if !claude_started => return Err("Claude 响应缺少 message_start".into()),
                        _ => {}
                    }
                }
                let mut event = match kind {
                    ProviderKind::OpenAi => parse_openai_event(&frame.data, &mut acc)?,
                    ProviderKind::Claude => parse_claude_event(&frame.data, &mut acc)?,
                };
                if let Some(error) = event.error.take() {
                    return Err(error);
                }
                if let Some(model) = &event.model {
                    response.model = Some(model.clone());
                }
                if let Some(delta) = &event.delta {
                    response.content.push_str(delta);
                }
                if kind.is_claude() {
                    merge_claude_usage(&mut response.usage, &value);
                } else if let Some(usage) = &event.usage {
                    response.usage = Some(usage.clone());
                }
                if event.usage.is_some() {
                    event.usage = response.usage.clone();
                }
                if event.kind == "completed" {
                    finished = true;
                    // Keep text/usage even when the parser identifies the same event
                    // as a completion. Only the final return emits "completed".
                    event.tool_calls = None;
                    event.kind = if event.delta.is_some() {
                        "delta"
                    } else if event.usage.is_some() {
                        "usage"
                    } else {
                        "ignored"
                    }
                    .into();
                }
                if event.delta.is_some() {
                    event.kind = "delta".into();
                }
                if event.kind != "ignored" || event.delta.is_some() || event.usage.is_some() {
                    on_event(event);
                }
                if kind.is_claude() && finished {
                    return finish_stream(
                        response,
                        cancellation.is_cancelled(),
                        &acc,
                        &mut on_event,
                    );
                }
            }
        }
    }
}

pub fn ensure_complete(
    completed: bool,
    cancelled: bool,
    pending_sse_bytes: usize,
) -> Result<(), String> {
    if cancelled {
        return Ok(());
    }
    if pending_sse_bytes != 0 {
        return Err("AI 流式响应意外截断：存在未完成的 SSE 数据".to_string());
    }
    if !completed {
        return Err("AI 流式响应意外结束：供应商未发送完成事件".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// All HTTP tests are loopback-only, with no real provider or credentials.
    async fn local_http(
        status: &str,
        content_type: &str,
        pieces: Vec<Vec<u8>>,
    ) -> (RequestBuilder, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/test", listener.local_addr().unwrap());
        let status = status.to_string();
        let content_type = content_type.to_string();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let length: usize = pieces.iter().map(Vec::len).sum();
            let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
            if socket.write_all(headers.as_bytes()).await.is_ok() {
                for piece in pieces {
                    if socket.write_all(&piece).await.is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }
            String::from_utf8(request).unwrap()
        });
        (reqwest::Client::new().post(url), task)
    }

    fn sse(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    fn openai_text(text: &str, finish: Value) -> Value {
        json!({"model":"loopback-model","choices":[{"delta":{"content":text},"finish_reason":finish}]})
    }

    async fn run_stream(
        kind: ProviderKind,
        body: String,
    ) -> (Result<ProviderResponse, String>, Vec<ProviderEvent>) {
        let (builder, server) = local_http(
            "200 OK",
            "text/event-stream; charset=utf-8",
            vec![body.into_bytes()],
        )
        .await;
        let mut events = Vec::new();
        let result = stream_request(
            builder,
            kind,
            Arc::new(crate::ai_tools::Cancellation::default()),
            |event| events.push(event),
        )
        .await;
        server.await.unwrap();
        (result, events)
    }

    async fn cancellation_handle() -> (
        Arc<crate::ai_tools::ExecutionTracker>,
        Arc<crate::ai_tools::Cancellation>,
        tokio::task::JoinHandle<crate::ai_tools::ToolExecutionResult>,
    ) {
        let tracker = Arc::new(crate::ai_tools::ExecutionTracker::default());
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let execution_tracker = tracker.clone();
        let task = tokio::spawn(async move {
            execution_tracker.execute(crate::ai_tools::ExecuteToolRequest {
                tool_id: None,
                tool_call_id: "provider_test_cancel".into(),
                name: "run_terminal_command".into(),
                arguments: json!({"terminal_id":"00000000-0000-0000-0000-000000000001","command":"echo local","timeout_ms":30000}),
                approved: true,
                execution_intent: crate::ai_tools::ExecutionIntent::ApproveOnce,
                timeout_ms: Some(30000),
                conversation_id: None,
                agent_id: None,
                step_index: None,
            }, move |_, cancellation| async move {
                sender.send(cancellation).ok();
                std::future::pending::<Result<(String, bool), String>>().await
            }).await
        });
        let cancellation = receiver.await.unwrap();
        (tracker, cancellation, task)
    }

    #[test]
    fn registry_and_protocol_capabilities_are_single_source() {
        assert_eq!(tool_specs(), crate::ai_tools::openai_specs());
        assert_eq!(
            claude_tools()[0]["input_schema"],
            tool_specs()[0]["function"]["parameters"]
        );
        assert_eq!(
            CLAUDE_FALLBACK_MAX_TOKENS,
            crate::ai_config::AI_CLAUDE_FALLBACK_MAX_TOKENS
        );
        assert_eq!(ProviderKind::OpenAi.capabilities().reasoning_effort, None);
        assert_eq!(ProviderKind::Claude.capabilities().vision, None);
        let model: ProviderModel = serde_json::from_value(
            json!({"id":"m","provider_id":"p","account_id":"a","model":"m"}),
        )
        .unwrap();
        assert_eq!(model.capabilities, ProviderCapabilities::default());
        assert!(!serde_json::to_string(&model).unwrap().contains("api_key"));
    }

    #[test]
    fn unified_payloads_have_native_tools_and_usage() {
        let messages = [
            json!({"role":"system","content":[{"type":"text","text":"rules"}]}),
            json!({"role":"user","content":"hello"}),
        ];
        let openai = build_payload(
            ProviderKind::OpenAi,
            "m",
            &messages,
            true,
            0,
            Some("low"),
            true,
        )
        .unwrap();
        assert_eq!(openai["tools"], json!(crate::ai_tools::openai_specs()));
        assert_eq!(openai["stream_options"]["include_usage"], true);
        assert!(openai.get("max_tokens").is_none());
        let plain =
            build_payload(ProviderKind::OpenAi, "m", &messages, false, 15, None, false).unwrap();
        assert!(plain.get("tools").is_none());
        assert!(plain.get("stream_options").is_none());
        assert_eq!(plain["max_tokens"], 15);
        let claude =
            build_payload(ProviderKind::Claude, "m", &messages, true, 0, None, true).unwrap();
        assert_eq!(claude["system"], "rules");
        assert_eq!(claude["max_tokens"], CLAUDE_FALLBACK_MAX_TOKENS);
        assert_eq!(claude["tools"], json!(claude_tools()));
        assert!(claude["tools"][0].get("function").is_none());
        assert!(build_payload(
            ProviderKind::Claude,
            "m",
            &messages,
            true,
            0,
            Some("low"),
            false
        )
        .is_err());
        assert!(build_payload(
            ProviderKind::OpenAi,
            "m",
            &[json!({"role":"unknown"})],
            true,
            0,
            None,
            false
        )
        .is_err());
    }

    #[test]
    fn reasoning_menu_values_are_validated_and_sent_unchanged() {
        let messages = [json!({"role":"user","content":"hello"})];
        for effort in ["none", "low", "medium", "high", "xhigh", "max", "minimal"] {
            let validated = crate::ai_config::validate_ai_reasoning_effort(effort).unwrap();
            let payload = build_payload(
                ProviderKind::OpenAi,
                "m",
                &messages,
                false,
                0,
                crate::ai_config::ai_request_reasoning_effort(&validated),
                false,
            )
            .unwrap();
            if effort == "none" {
                assert!(payload.get("reasoning_effort").is_none());
            } else {
                assert_eq!(payload["reasoning_effort"], effort);
            }
        }
        assert!(crate::ai_config::validate_ai_reasoning_effort("invalid").is_err());
        assert!(build_payload(
            ProviderKind::OpenAi,
            "m",
            &messages,
            false,
            0,
            Some("invalid"),
            false
        )
        .is_err());
    }

    #[test]
    fn payload_rejects_unknown_tools_bad_json_and_duplicate_ids() {
        let message = |name: &str, args: &str| json!({"role":"assistant","tool_calls":[{"id":"x","type":"function","function":{"name":name,"arguments":args}}]});
        for kind in [ProviderKind::OpenAi, ProviderKind::Claude] {
            assert!(
                build_payload(kind, "m", &[message("unknown", "{}")], true, 0, None, true).is_err()
            );
            assert!(build_payload(
                kind,
                "m",
                &[message("call_mcp_tool", "{")],
                true,
                0,
                None,
                true
            )
            .is_err());
            assert!(build_payload(
                kind,
                "m",
                &[message("call_mcp_tool", "[]")],
                true,
                0,
                None,
                true
            )
            .is_err());
            let duplicate = message("call_mcp_tool", "{}");
            assert!(build_payload(
                kind,
                "m",
                &[duplicate.clone(), duplicate],
                true,
                0,
                None,
                true
            )
            .is_err());
        }
    }

    #[test]
    fn nonstream_openai_array_text_tools_and_usage() {
        let body = json!({"model":"m","choices":[{"message":{"content":[{"type":"text","text":"one"},{"type":"text","text":"two"}],"tool_calls":[{"id":"x","type":"function","function":{"name":"call_mcp_tool","arguments":"{}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}});
        let response = parse_response(ProviderKind::OpenAi, &body.to_string()).unwrap();
        assert_eq!(response.content, "onetwo");
        assert_eq!(response.model.as_deref(), Some("m"));
        assert_eq!(response.usage.unwrap().total_tokens, 8);
        assert_eq!(response.tool_calls[0].name, "call_mcp_tool");
        assert!(!response.cancelled);
    }

    #[test]
    fn nonstream_claude_text_tools_and_cache_usage() {
        let body = json!({"type":"message","model":"claude-test","content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"x","name":"run_terminal_command","input":{"command":"echo hi"}}],"usage":{"input_tokens":5,"output_tokens":3,"cache_read_input_tokens":7,"cache_creation_input_tokens":2}});
        let response = parse_response(ProviderKind::Claude, &body.to_string()).unwrap();
        assert_eq!(response.content, "hello");
        assert_eq!(response.tool_calls[0].arguments, r#"{"command":"echo hi"}"#);
        assert_eq!(response.usage.unwrap().total_tokens, 17);
    }

    #[test]
    fn nonstream_errors_and_invalid_wire_formats_are_rejected() {
        for kind in [ProviderKind::OpenAi, ProviderKind::Claude] {
            assert!(parse_response(kind, "{").is_err());
            assert_eq!(
                parse_response(kind, r#"{"error":{"message":"denied"}}"#).unwrap_err(),
                "denied"
            );
            assert!(parse_response(kind, "{}").is_err());
        }
        assert!(parse_response(
            ProviderKind::Claude,
            r#"{"type":"message","content":[{"type":"unknown"}]}"#
        )
        .is_err());
        assert!(parse_response(ProviderKind::OpenAi, r#"{"choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"unknown","arguments":"{}"}}]}}]}"#).is_err());
    }

    #[test]
    fn accumulator_rejects_duplicates_unknown_names_invalid_arguments_and_limits() {
        let mut acc = ToolAccumulator::default();
        acc.apply_openai(0, Some("x"), Some("call_mcp_tool"), Some("{}"))
            .unwrap();
        acc.apply_openai(1, Some("x"), Some("call_mcp_tool"), Some("{}"))
            .unwrap();
        assert!(acc.finish().is_err());
        assert!(acc.apply_openai(MAX_TOOL_CALLS, None, None, None).is_err());
        assert!(acc.apply_openai(0, Some("changed"), None, None).is_err());
        let mut acc = ToolAccumulator::default();
        acc.apply_openai(0, None, Some("unknown"), Some("{}"))
            .unwrap();
        assert!(acc.finish().is_err());
        let mut acc = ToolAccumulator::default();
        acc.apply_openai(0, None, Some("call_mcp_tool"), Some("{"))
            .unwrap();
        assert!(acc.finish().is_err());
        assert!(acc
            .apply_openai(0, None, None, Some(&"x".repeat(MAX_TOOL_ARGUMENT_CHARS)))
            .is_err());
        let mut acc = ToolAccumulator::default();
        for index in 0..2 {
            acc.apply_openai(index, None, Some("call_mcp_tool"), Some("{}"))
                .unwrap();
        }
        let calls = acc.finish().unwrap();
        assert_ne!(calls[0].id, calls[1].id);
        assert_eq!(calls, acc.finish().unwrap());
        let mut acc = ToolAccumulator::default();
        acc.apply_openai(0, None, Some("call_mcp_tool"), Some(" "))
            .unwrap();
        assert!(acc.finish().is_err());
    }

    #[test]
    fn sse_decoder_preserves_utf8_crlf_multiline_and_rejects_oversize() {
        let body = ": comment\r\nevent: message\r\ndata: {\r\ndata: \"text\":\"熊猫\"}\r\n\r\n";
        let mut decoder = SseDecoder::default();
        let mut frames = Vec::new();
        for byte in body.as_bytes() {
            frames.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "{\n\"text\":\"熊猫\"}");
        assert_eq!(decoder.pending_bytes(), 0);
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(&vec![b'x'; MAX_SSE_EVENT_BYTES + 1]).is_err());
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: \xff\n\n").is_err());
    }

    #[tokio::test]
    async fn http_fragmented_utf8_and_crlf_are_preserved() {
        let body =
            (sse(openai_text("熊猫", json!("stop"))) + "data: [DONE]\n\n").replace('\n', "\r\n");
        let pieces = body.as_bytes().chunks(3).map(<[u8]>::to_vec).collect();
        let (builder, server) = local_http("200 OK", "text/event-stream", pieces).await;
        let response = stream_request(
            builder,
            ProviderKind::OpenAi,
            Arc::new(crate::ai_tools::Cancellation::default()),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(response.content, "熊猫");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_terminal_markers_stop_before_unrelated_trailing_bytes() {
        for kind in [ProviderKind::OpenAi, ProviderKind::Claude] {
            let mut body = if kind.is_claude() {
                (sse(json!({"type":"message_start","message":{}}))
                    + &sse(json!({"type":"message_stop"})))
                    .into_bytes()
            } else {
                b"data: [DONE]\n\n".to_vec()
            };
            body.extend_from_slice(b"data: \xff\n\n");
            let (builder, server) = local_http("200 OK", "text/event-stream", vec![body]).await;
            let mut completions = 0;
            stream_request(
                builder,
                kind,
                Arc::new(crate::ai_tools::Cancellation::default()),
                |event| {
                    if event.kind == "completed" {
                        completions += 1;
                    }
                },
            )
            .await
            .unwrap();
            assert_eq!(completions, 1);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_tool_validation_rejects_bad_json_unknown_names_and_duplicate_ids() {
        for calls in [
            json!([{"index":0,"id":"x","function":{"name":"unknown","arguments":"{}"}}]),
            json!([{"index":0,"id":"x","function":{"name":"call_mcp_tool","arguments":"{"}}]),
            json!([{"index":0,"id":"x","function":{"name":"call_mcp_tool","arguments":"{}"}},{"index":1,"id":"x","function":{"name":"call_mcp_tool","arguments":"{}"}}]),
        ] {
            let body =
                sse(json!({"choices":[{"delta":{"tool_calls":calls},"finish_reason":null}]}))
                    + "data: [DONE]\n\n";
            let (result, events) = run_stream(ProviderKind::OpenAi, body).await;
            assert!(result.is_err());
            assert!(!events.iter().any(|event| event.kind == "completed"));
        }
    }

    #[tokio::test]
    async fn http_openai_keeps_usage_tail_and_emits_completion_once() {
        let mut body = sse(openai_text("hello", Value::Null));
        body.push_str(&sse(openai_text(" world", json!("stop"))));
        body.push_str(&sse(json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}})));
        body.push_str("data: [DONE]\n\n");
        let (response, events) = run_stream(ProviderKind::OpenAi, body).await;
        let response = response.unwrap();
        assert_eq!(response.content, "hello world");
        assert_eq!(response.usage.as_ref().unwrap().input_tokens, 11);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "completed")
                .count(),
            1
        );
        assert_eq!(
            events.last().unwrap().usage.as_ref().unwrap().total_tokens,
            18
        );
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.delta.as_deref())
                .collect::<String>(),
            response.content
        );
    }

    #[tokio::test]
    async fn http_openai_combined_delta_usage_and_tools_keeps_text() {
        let body = sse(
            json!({"choices":[{"delta":{"content":[{"type":"text","text":"keep me"}],"tool_calls":[{"index":0,"id":"x","type":"function","function":{"name":"call_mcp_tool","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}),
        ) + "data: [DONE]\n\n";
        let (response, events) = run_stream(ProviderKind::OpenAi, body).await;
        let response = response.unwrap();
        assert_eq!(response.content, "keep me");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.usage.unwrap().total_tokens, 5);
        assert_eq!(events[0].delta.as_deref(), Some("keep me"));
        assert!(events[0].usage.is_some());
        assert!(events[0].tool_calls.is_none());
    }

    #[tokio::test]
    async fn http_claude_merges_cumulative_usage_and_initial_text() {
        let body = [
            json!({"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello "}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"},"usage":{"output_tokens":2}}),
            json!({"type":"message_delta","usage":{"output_tokens":4}}),
            json!({"type":"message_stop"}),
        ].into_iter().map(sse).collect::<String>();
        let (response, events) = run_stream(ProviderKind::Claude, body).await;
        let response = response.unwrap();
        assert_eq!(response.content, "hello world");
        assert_eq!(
            response.usage.unwrap(),
            Usage {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 21,
                cache_read_tokens: Some(5),
                cache_write_tokens: Some(2)
            }
        );
        let delta = events
            .iter()
            .find(|event| event.delta.as_deref() == Some("world"))
            .unwrap();
        assert_eq!(delta.usage.as_ref().unwrap().input_tokens, 10);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "completed")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn http_claude_tools_retain_initial_input_without_json_deltas() {
        let body = [
            json!({"type":"message_start","message":{}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"x","name":"call_mcp_tool","input":{"server":"local"}}}),
            json!({"type":"message_stop"}),
        ].into_iter().map(sse).collect::<String>();
        let (response, _) = run_stream(ProviderKind::Claude, body).await;
        assert_eq!(
            response.unwrap().tool_calls[0].arguments,
            r#"{"server":"local"}"#
        );
    }

    #[tokio::test]
    async fn http_openai_eof_after_finish_is_valid_but_unfinished_eof_is_error() {
        let (response, events) = run_stream(
            ProviderKind::OpenAi,
            sse(openai_text("done", json!("stop"))),
        )
        .await;
        assert_eq!(response.unwrap().content, "done");
        assert_eq!(events.last().unwrap().kind, "completed");
        let (result, events) = run_stream(
            ProviderKind::OpenAi,
            sse(openai_text("partial", Value::Null)),
        )
        .await;
        assert!(result.is_err());
        assert!(!events.iter().any(|event| event.kind == "completed"));
        let (result, _) = run_stream(
            ProviderKind::OpenAi,
            sse(openai_text("done", json!("stop"))) + "data: {",
        )
        .await;
        assert!(result.is_err());
        let (result, _) = run_stream(
            ProviderKind::Claude,
            sse(json!({"type":"message_start","message":{}})),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn http_stream_errors_are_returned_without_completion_or_error_callback() {
        for (kind, body) in [
            (
                ProviderKind::OpenAi,
                sse(json!({"error":{"message":"upstream denied"}})),
            ),
            (
                ProviderKind::Claude,
                sse(json!({"type":"error","error":{"message":"upstream denied"}})),
            ),
        ] {
            let (result, events) = run_stream(kind, body).await;
            assert_eq!(result.unwrap_err(), "upstream denied");
            assert!(events.is_empty());
        }
        let body = sse(openai_text("done", json!("stop")))
            + &sse(json!({"error":{"message":"tail failure"}}));
        let (result, events) = run_stream(ProviderKind::OpenAi, body).await;
        assert_eq!(result.unwrap_err(), "tail failure");
        assert!(!events.iter().any(|event| event.kind == "completed"));
    }

    #[tokio::test]
    async fn http_rejects_unknown_event_mismatched_wire_invalid_json_and_oversize() {
        for (kind, body) in [
            (ProviderKind::Claude, sse(json!({"type":"unknown"}))),
            (
                ProviderKind::Claude,
                "event: message_start\ndata: {\"type\":\"message_stop\"}\n\n".into(),
            ),
            (ProviderKind::Claude, sse(json!({"type":"message_stop"}))),
            (ProviderKind::OpenAi, "event: unknown\ndata: {}\n\n".into()),
            (
                ProviderKind::OpenAi,
                "event: unknown\ndata: [DONE]\n\n".into(),
            ),
            (
                ProviderKind::OpenAi,
                sse(json!({"choices":[],"usage":{"prompt_tokens":"invalid"}})),
            ),
            (
                ProviderKind::OpenAi,
                sse(openai_text("bad finish", json!("unknown"))),
            ),
            (ProviderKind::OpenAi, "data: {\n\n".into()),
            (
                ProviderKind::OpenAi,
                format!("data: {}", "x".repeat(MAX_SSE_EVENT_BYTES)),
            ),
        ] {
            let (result, events) = run_stream(kind, body).await;
            assert!(result.is_err());
            assert!(!events.iter().any(|event| event.kind == "completed"));
        }
    }

    #[tokio::test]
    async fn http_uses_auth_headers_and_exact_native_payload() {
        for (kind, format, key) in [
            (ProviderKind::OpenAi, "openai", Some("local-test")),
            (ProviderKind::Claude, "claude", None),
            (ProviderKind::Claude, "claude", Some("local-test")),
        ] {
            let wire = if kind.is_claude() {
                sse(json!({"type":"message_start","message":{}}))
                    + &sse(json!({"type":"message_stop"}))
            } else {
                "data: [DONE]\n\n".into()
            };
            let (builder, server) =
                local_http("200 OK", "text/event-stream", vec![wire.into_bytes()]).await;
            let payload = build_payload(
                kind,
                "m",
                &[json!({"role":"user","content":"hello"})],
                true,
                0,
                None,
                true,
            )
            .unwrap();
            stream_request(
                apply_auth(builder, format, key).json(&payload),
                kind,
                Arc::new(crate::ai_tools::Cancellation::default()),
                |_| {},
            )
            .await
            .unwrap();
            let request = server.await.unwrap();
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            let lower = headers.to_ascii_lowercase();
            if kind.is_claude() {
                assert!(lower.contains("anthropic-version: 2023-06-01"));
                assert_eq!(lower.contains("x-api-key:"), key.is_some());
                assert!(!lower.contains("authorization:"));
            } else {
                assert!(lower.contains("authorization: bearer local-test"));
            }
            assert_eq!(serde_json::from_str::<Value>(body).unwrap(), payload);
        }
    }

    #[tokio::test]
    async fn http_error_body_is_bounded_and_wrong_content_type_is_rejected() {
        let (builder, server) = local_http(
            "429 Too Many Requests",
            "application/json",
            vec![br#"{"error":{"message":"limited"}}"#.to_vec()],
        )
        .await;
        let error = stream_request(
            builder,
            ProviderKind::OpenAi,
            Arc::new(crate::ai_tools::Cancellation::default()),
            |_| panic!("error must not emit callbacks"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("429"));
        assert!(error.contains("limited"));
        server.await.unwrap();
        let (builder, server) = local_http(
            "500 Internal Server Error",
            "text/plain",
            vec![vec![b'x'; MAX_ERROR_BODY_BYTES * 2]],
        )
        .await;
        let error = stream_request(
            builder,
            ProviderKind::OpenAi,
            Arc::new(crate::ai_tools::Cancellation::default()),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(error.len() < MAX_ERROR_BODY_BYTES + 100);
        server.await.unwrap();
        let (builder, server) =
            local_http("200 OK", "application/json", vec![b"{}".to_vec()]).await;
        assert!(stream_request(
            builder,
            ProviderKind::OpenAi,
            Arc::new(crate::ai_tools::Cancellation::default()),
            |_| {}
        )
        .await
        .is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_request_is_explicit_and_emits_one_final_event() {
        let (tracker, cancellation, task) = cancellation_handle().await;
        tracker.cancel("provider_test_cancel").unwrap();
        task.await.unwrap();
        let mut events = Vec::new();
        let response = stream_request(
            reqwest::Client::new().post("http://127.0.0.1:1"),
            ProviderKind::OpenAi,
            cancellation,
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert!(response.cancelled);
        assert!(response.tool_calls.is_empty());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].cancelled, Some(true));
    }

    #[tokio::test]
    async fn cancellation_interrupts_header_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            accepted_tx.send(()).unwrap();
            std::future::pending::<()>().await;
            drop(socket);
        });
        let (tracker, cancellation, task) = cancellation_handle().await;
        let request = tokio::spawn(stream_request(
            reqwest::Client::new().post(url),
            ProviderKind::OpenAi,
            cancellation,
            |_| {},
        ));
        accepted_rx.await.unwrap();
        tracker.cancel("provider_test_cancel").unwrap();
        let response = tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(response.cancelled);
        task.await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn cancellation_interrupts_idle_and_error_body_waits() {
        for error_response in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                socket.read(&mut request).await.unwrap();
                if error_response {
                    socket.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 99999\r\n\r\n").await.unwrap();
                } else {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 99999\r\n\r\n").await.unwrap();
                    socket
                        .write_all(sse(openai_text("partial", Value::Null)).as_bytes())
                        .await
                        .unwrap();
                }
                ready_tx.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            let (tracker, cancellation, task) = cancellation_handle().await;
            let (delta_tx, delta_rx) = tokio::sync::oneshot::channel();
            let mut delta_tx = Some(delta_tx);
            let request = tokio::spawn(stream_request(
                reqwest::Client::new().post(url),
                ProviderKind::OpenAi,
                cancellation,
                move |event| {
                    if event.delta.is_some() {
                        if let Some(sender) = delta_tx.take() {
                            sender.send(()).unwrap();
                        }
                    }
                },
            ));
            ready_rx.await.unwrap();
            if !error_response {
                tokio::time::timeout(Duration::from_secs(2), delta_rx)
                    .await
                    .unwrap()
                    .unwrap();
            }
            tracker.cancel("provider_test_cancel").unwrap();
            let response = tokio::time::timeout(Duration::from_secs(2), request)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(response.cancelled);
            assert_eq!(
                response.content,
                if error_response { "" } else { "partial" }
            );
            task.await.unwrap();
            server.abort();
        }
    }

    #[tokio::test]
    async fn cancellation_from_delta_retains_text_and_discards_partial_tools() {
        let body = sse(
            json!({"choices":[{"delta":{"content":"partial","tool_calls":[{"index":0,"id":"x","type":"function","function":{"name":"call_mcp_tool","arguments":"{"}}]},"finish_reason":null}]}),
        ) + "data: [DONE]\n\n";
        let (builder, server) =
            local_http("200 OK", "text/event-stream", vec![body.into_bytes()]).await;
        let (tracker, cancellation, task) = cancellation_handle().await;
        let mut events = Vec::new();
        let response = stream_request(builder, ProviderKind::OpenAi, cancellation, |event| {
            if event.delta.is_some() {
                tracker.cancel("provider_test_cancel").unwrap();
            }
            events.push(event);
        })
        .await
        .unwrap();
        assert!(response.cancelled);
        assert_eq!(response.content, "partial");
        assert!(response.tool_calls.is_empty());
        assert_eq!(events.last().unwrap().cancelled, Some(true));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "completed")
                .count(),
            1
        );
        server.await.unwrap();
        task.await.unwrap();
    }

    #[test]
    fn claude_tool_use_and_result_are_translated() {
        let messages = vec![
            json!({"role":"assistant","content":"","tool_calls":[{"id":"x","type":"function","function":{"name":"run_terminal_command","arguments":r#"{"command":"echo hi"}"#}}]}),
            json!({"role":"tool","content":"ok","tool_call_id":"x"}),
        ];
        let payload =
            build_claude_payload("claude-3", &messages, true, 0, Some(&tool_specs())).unwrap();
        assert_eq!(payload["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(payload["messages"][2]["content"][0]["type"], "tool_result");
    }
    #[test]
    fn tool_results_must_match_pending_calls_exactly() {
        let assistant = json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id":"call_a","type":"function","function":{"name":"call_mcp_tool","arguments":"{}"}}]
        });
        let valid = vec![
            assistant.clone(),
            json!({"role":"tool","content":"ok","tool_call_id":"call_a"}),
        ];
        assert!(validate_messages(&valid).is_ok());
        for id in ["call_unknown", "call_a"] {
            let invalid = vec![
                assistant.clone(),
                json!({"role":"tool","content":"ok","tool_call_id":id}),
                json!({"role":"tool","content":"again","tool_call_id":"call_a"}),
            ];
            assert!(validate_messages(&invalid).is_err());
        }
        assert!(validate_messages(&[assistant]).is_err());
    }

    #[test]
    fn claude_input_json_delta_is_accumulated() {
        let mut acc = ToolAccumulator::default();
        parse_claude_event(r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"x","name":"call_mcp_tool","input":{}}}"#, &mut acc).unwrap();
        parse_claude_event(r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"server\":\"s\"}"}}"#, &mut acc).unwrap();
        let calls = acc.finish().unwrap();
        assert_eq!(calls[0].arguments, r#"{"server":"s"}"#);
    }
}
