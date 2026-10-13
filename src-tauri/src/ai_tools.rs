//! Native tool schemas, fail-closed execution policy, and bounded execution tracking.
//! File edits are prepared and verified before the execution gate can write them.
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;

pub const MAX_TRACKED_EXECUTIONS: usize = 256;
const MAX_ACTIVE_EXECUTIONS: usize = 64;
const MAX_RESULT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Terminal,
    FileEdit,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Ask,
    Allow,
    Deny,
}

/// User-selected policy for AI-originated tool execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPermissionPolicy {
    Ask,
    Edit,
    Allowlist,
    Full,
}

impl Default for AiPermissionPolicy {
    fn default() -> Self {
        Self::Ask
    }
}

/// Why the frontend submitted this concrete invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionIntent {
    Automatic,
    ApproveOnce,
    ApproveAndRemember,
}

impl Default for ExecutionIntent {
    fn default() -> Self {
        Self::Automatic
    }
}

/// Evaluate policy after the invocation has been parsed and validated.
/// `allowlisted` must describe this exact invocation, never a tool-wide grant.
pub fn evaluate_policy(
    policy: AiPermissionPolicy,
    kind: ToolKind,
    intent: ExecutionIntent,
    allowlisted: bool,
) -> PermissionDecision {
    match (policy, intent) {
        (AiPermissionPolicy::Ask, ExecutionIntent::Automatic) => PermissionDecision::Deny,
        (AiPermissionPolicy::Ask, _) => PermissionDecision::Allow,
        (AiPermissionPolicy::Edit, ExecutionIntent::Automatic) => {
            if kind == ToolKind::FileEdit {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        }
        (AiPermissionPolicy::Edit, _) => PermissionDecision::Allow,
        (AiPermissionPolicy::Allowlist, ExecutionIntent::Automatic) => {
            if allowlisted {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        }
        // Allowlist mode is deliberately fail-closed: an explicit one-time
        // approval cannot silently create an execution outside the list.
        (AiPermissionPolicy::Allowlist, _) => PermissionDecision::Deny,
        (AiPermissionPolicy::Full, _) => PermissionDecision::Allow,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub kind: ToolKind,
    pub description: String,
    pub permission: PermissionDecision,
    pub input_schema: Value,
}

/// The single model-facing schema source. Executable arguments are deliberately
/// different: the UI must resolve and authorize a real terminal or reviewed file.
pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "run_terminal_command".into(),
            kind: ToolKind::Terminal,
            description: "提交终端命令授权提案；未经授权不会执行。".into(),
            permission: PermissionDecision::Ask,
            input_schema: json!({
                "type":"object", "additionalProperties":false,
                "properties": {
                    "summary":{"type":"string","minLength":1,"maxLength":500},
                    "context_source":{"type":"string","minLength":1},
                    "command":{"type":"string","minLength":1,"maxLength":4000},
                    "timeout_ms":{"type":"integer","minimum":3000,"maximum":30000,"default":10000}
                },
                "required":["summary","context_source","command"]
            }),
        },
        ToolDefinition {
            name: "propose_file_edit".into(),
            kind: ToolKind::FileEdit,
            description: "提交精确文件编辑提案；系统会在策略授权后读取、校验并执行。".into(),
            permission: PermissionDecision::Ask,
            input_schema: json!({
                "type":"object", "additionalProperties":false,
                "properties": {
                    "summary":{"type":"string","minLength":1,"maxLength":500},
                    "target_source":{"type":"string","minLength":1},
                    "edits":{"type":"array","minItems":1,"items":{
                        "type":"object","additionalProperties":false,
                        "properties":{"search":{"type":"string","minLength":1},"replace":{"type":"string"}},
                        "required":["search","replace"]
                    }}
                },
                "required":["summary","target_source","edits"]
            }),
        },
        ToolDefinition {
            name: "call_mcp_tool".into(),
            kind: ToolKind::Mcp,
            description: "提交 MCP 工具调用授权提案；未经授权不会调用。".into(),
            permission: PermissionDecision::Ask,
            input_schema: json!({
                "type":"object", "additionalProperties":false,
                "properties": {
                    "summary":{"type":"string","minLength":1,"maxLength":500},
                    "server":{"type":"string","minLength":1},
                    "tool":{"type":"string","minLength":1,"maxLength":128},
                    "arguments":{"type":"object"}
                },
                "required":["summary","server","tool","arguments"]
            }),
        },
    ]
}

pub fn find(name: &str) -> Option<ToolDefinition> {
    definitions().into_iter().find(|tool| tool.name == name)
}

pub fn decide(
    name: &str,
    approved: bool,
    cancelled: bool,
    timed_out: bool,
) -> Result<PermissionDecision, String> {
    find(name).ok_or_else(|| format!("未注册的 Agent 工具：{name}"))?;
    Ok(if cancelled || timed_out || !approved {
        PermissionDecision::Deny
    } else {
        PermissionDecision::Allow
    })
}

pub fn openai_specs() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|tool| {
            json!({
                "type":"function", "function":{
                    "name":tool.name, "description":tool.description, "parameters":tool.input_schema
                }
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteToolRequest {
    /// Stable UI action identity, distinct from the provider call identity.
    #[serde(default)]
    pub tool_id: Option<String>,
    pub tool_call_id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
    /// Legacy approval bit retained for wire compatibility. New callers must
    /// use `execution_intent`; policy evaluation does not trust this bit alone.
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub execution_intent: ExecutionIntent,
    pub timeout_ms: Option<u64>,
    /// Conversation routing metadata is echoed on every native result.
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub step_index: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolExecutionResult {
    /// Stable UI action identity, echoed independently from the provider call ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    pub tool_call_id: String,
    pub name: String,
    pub status: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<u64>,
}

impl ToolExecutionResult {
    pub fn new(
        request: &ExecuteToolRequest,
        status: &str,
        content: impl Into<String>,
        is_error: bool,
    ) -> Self {
        let mut content = content.into();
        if content.len() > MAX_RESULT_BYTES {
            let mut end = MAX_RESULT_BYTES;
            while !content.is_char_boundary(end) {
                end -= 1;
            }
            content.truncate(end);
            content.push_str("\n[工具结果已截断]");
        }
        Self {
            tool_id: request.tool_id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            name: request.name.clone(),
            status: status.into(),
            content,
            is_error,
            conversation_id: request.conversation_id.clone(),
            agent_id: request.agent_id.clone(),
            step_index: request.step_index,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalArguments {
    pub terminal_id: String,
    /// Optional legacy UI hint; the adapter verifies it against the actual session.
    pub is_remote: Option<bool>,
    pub command: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEditArguments {
    pub path: String,
    pub terminal_id: Option<String>,
    pub original_content: String,
    pub new_content: String,
    #[serde(default)]
    pub edits: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpArguments {
    pub server: String,
    pub tool: String,
    pub arguments: Value,
}

#[derive(Debug)]
pub enum Invocation {
    Terminal(TerminalArguments),
    FileEdit(FileEditArguments),
    Mcp(McpArguments),
}

pub struct ValidatedExecution {
    pub invocation: Invocation,
    pub timeout: Duration,
}

pub fn validate_tool_call_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
    {
        return Err("工具调用标识必须为 1-200 个字母、数字或 -_.: 字符".into());
    }
    Ok(())
}

/// Apply the frontend's sequential edit proposal with the same exact-match
/// rules used by preparation and execution. Every search must occur exactly
/// once in the content at that step, and a proposal must change the content.
pub fn apply_file_edits(original: &str, edits: &[Value]) -> Result<String, String> {
    if edits.is_empty() {
        return Err("文件编辑提案不能为空".into());
    }
    let mut content = original.to_owned();
    for edit in edits {
        let search = edit
            .get("search")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "文件编辑搜索内容不能为空".to_string())?;
        let replace = edit
            .get("replace")
            .and_then(Value::as_str)
            .ok_or_else(|| "文件编辑替换内容无效".to_string())?;
        let occurrences = content.match_indices(search).count();
        if occurrences != 1 {
            return Err(if occurrences == 0 {
                "AI_EDIT_STALE:搜索内容不存在或文件已变化".into()
            } else {
                "AI_EDIT_AMBIGUOUS:搜索内容必须只匹配一次".into()
            });
        }
        let position = content.find(search).expect("one match was counted");
        content.replace_range(position..position + search.len(), replace);
    }
    if content == original {
        return Err("AI_EDIT_NO_CHANGE:文件编辑不会产生变化".into());
    }
    Ok(content)
}

pub fn validate_request(
    request: &ExecuteToolRequest,
) -> Result<ValidatedExecution, ToolExecutionResult> {
    let error = |message: String| ToolExecutionResult::new(request, "error", message, true);
    validate_tool_call_id(&request.tool_call_id).map_err(&error)?;
    if !request.arguments.is_object() {
        return Err(error("工具 arguments 必须为对象".into()));
    }
    let mut timeout_ms = request.timeout_ms.unwrap_or(120_000);
    let invocation = match request.name.as_str() {
        "run_terminal_command" => {
            let args: TerminalArguments = serde_json::from_value(request.arguments.clone())
                .map_err(|e| error(format!("终端执行参数无效：{e}")))?;
            uuid::Uuid::parse_str(&args.terminal_id).map_err(|_| error("终端标识无效".into()))?;
            if args.command.trim().is_empty() || args.command.len() > 4000 {
                return Err(error("命令长度必须为 1-4000 字节".into()));
            }
            timeout_ms = request.timeout_ms.or(args.timeout_ms).unwrap_or(10_000);
            if let Some(value) = args.timeout_ms {
                if !(3000..=30000).contains(&value) {
                    return Err(error("终端超时必须为 3000-30000 毫秒".into()));
                }
                if request.timeout_ms.is_some_and(|outer| outer != value) {
                    return Err(error("请求和终端参数的超时值必须一致".into()));
                }
            }
            if !(3000..=30000).contains(&timeout_ms) {
                return Err(error("终端超时必须为 3000-30000 毫秒".into()));
            }
            Invocation::Terminal(args)
        }
        "propose_file_edit" => {
            let args: FileEditArguments = serde_json::from_value(request.arguments.clone())
                .map_err(|e| {
                    error(format!(
                        "文件执行参数无效；需要 path/original_content/new_content，可选 edits：{e}"
                    ))
                })?;
            if args.path.trim().is_empty() || args.path.contains('\0') {
                return Err(error("文件路径无效".into()));
            }
            if let Some(id) = &args.terminal_id {
                uuid::Uuid::parse_str(id).map_err(|_| error("文件终端标识无效".into()))?;
            }
            Invocation::FileEdit(args)
        }
        "call_mcp_tool" => {
            let args: McpArguments = serde_json::from_value(request.arguments.clone())
                .map_err(|e| error(format!("MCP 执行参数无效：{e}")))?;
            if args.server.trim().is_empty()
                || args.server.len() > 200
                || args.tool.trim().is_empty()
                || args.tool.chars().count() > 128
                || !args.arguments.is_object()
            {
                return Err(error("MCP server/tool/arguments 无效".into()));
            }
            Invocation::Mcp(args)
        }
        _ => return Err(error("未注册的 Agent 工具".into())),
    };
    if timeout_ms == 0 || timeout_ms > 120_000 {
        return Err(error("工具超时必须为 1-120000 毫秒".into()));
    }
    Ok(ValidatedExecution {
        invocation,
        timeout: Duration::from_millis(timeout_ms),
    })
}

#[derive(Default)]
pub struct Cancellation {
    cancelled: AtomicBool,
    notification: Notify,
}

impl Cancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notification.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub async fn cancelled(&self) {
        // Register before checking the atomic flag: notify_waiters does not retain
        // permits, so a flag check followed by registration would lose a wakeup.
        let notified = self.notification.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.is_cancelled() {
            notified.await;
        }
    }
}

enum Entry {
    Tombstone,
    Running { cancellation: Arc<Cancellation> },
    Finished { status: String },
}

#[derive(Default)]
struct Tracking {
    entries: HashMap<String, Entry>,
    inactive: VecDeque<String>,
}

/// Completed IDs and cancellation tombstones are retained in a bounded FIFO.
/// Deduplication applies to the most recent 256 IDs, never evicting a running ID.
#[derive(Default)]
pub struct ExecutionTracker {
    tracking: Mutex<Tracking>,
}

impl ExecutionTracker {
    fn make_room(tracking: &mut Tracking) -> Result<(), String> {
        while tracking.entries.len() >= MAX_TRACKED_EXECUTIONS {
            let id = tracking
                .inactive
                .pop_front()
                .ok_or_else(|| "工具执行跟踪容量已满".to_string())?;
            tracking.entries.remove(&id);
        }
        Ok(())
    }

    pub fn cancel(&self, tool_call_id: &str) -> Result<(), String> {
        validate_tool_call_id(tool_call_id)?;
        let mut tracking = self.tracking.lock().unwrap_or_else(|e| e.into_inner());
        match tracking.entries.get(tool_call_id) {
            Some(Entry::Running { cancellation, .. }) => cancellation.cancel(),
            Some(Entry::Finished { .. }) | Some(Entry::Tombstone) => {}
            None => {
                Self::make_room(&mut tracking)?;
                tracking
                    .entries
                    .insert(tool_call_id.into(), Entry::Tombstone);
                tracking.inactive.push_back(tool_call_id.into());
            }
        }
        Ok(())
    }

    fn begin<'a>(
        &'a self,
        request: &ExecuteToolRequest,
    ) -> Result<ExecutionLease<'a>, ToolExecutionResult> {
        let mut tracking = self.tracking.lock().unwrap_or_else(|e| e.into_inner());
        match tracking.entries.get(&request.tool_call_id) {
            Some(Entry::Running { .. }) => {
                return Err(ToolExecutionResult::new(
                    request,
                    "error",
                    "工具调用标识正在执行；重复调用被拒绝，未再次执行",
                    true,
                ))
            }
            Some(Entry::Finished { status }) => {
                return Err(ToolExecutionResult::new(
                    request,
                    "error",
                    format!("工具调用标识已使用（原状态 {status}）；重复调用被拒绝，未再次执行"),
                    true,
                ))
            }
            Some(Entry::Tombstone) => {
                let result = ToolExecutionResult::new(
                    request,
                    "cancelled",
                    "工具在开始前已取消；未执行任何操作",
                    true,
                );
                tracking.entries.insert(
                    request.tool_call_id.clone(),
                    Entry::Finished {
                        status: result.status.clone(),
                    },
                );
                return Err(result);
            }
            None => {}
        }
        let active = tracking
            .entries
            .values()
            .filter(|e| matches!(e, Entry::Running { .. }))
            .count();
        if active >= MAX_ACTIVE_EXECUTIONS {
            return Err(ToolExecutionResult::new(
                request,
                "error",
                "同时执行的工具过多",
                true,
            ));
        }
        Self::make_room(&mut tracking)
            .map_err(|e| ToolExecutionResult::new(request, "error", e, true))?;
        let cancellation = Arc::new(Cancellation::default());
        tracking.entries.insert(
            request.tool_call_id.clone(),
            Entry::Running {
                cancellation: cancellation.clone(),
            },
        );
        let metadata = ExecuteToolRequest {
            tool_id: request.tool_id.clone(),
            tool_call_id: request.tool_call_id.clone(),
            name: request.name.clone(),
            arguments: Value::Null,
            approved: false,
            execution_intent: ExecutionIntent::Automatic,
            timeout_ms: None,
            conversation_id: request.conversation_id.clone(),
            agent_id: request.agent_id.clone(),
            step_index: request.step_index,
        };
        Ok(ExecutionLease {
            tracker: self,
            request: metadata,
            cancellation,
            finished: false,
        })
    }

    /// Invoke only after validation and approval; cancellation/timeout drop the
    /// adapter future. Adapters must provide their own transport/process cleanup.
    pub async fn execute<F, Fut>(
        &self,
        request: ExecuteToolRequest,
        adapter: F,
    ) -> ToolExecutionResult
    where
        F: FnOnce(Invocation, Arc<Cancellation>) -> Fut,
        Fut: Future<Output = Result<(String, bool), String>>,
    {
        if let Err(error) = validate_tool_call_id(&request.tool_call_id) {
            return ToolExecutionResult::new(&request, "error", error, true);
        }
        if find(&request.name).is_none() {
            return ToolExecutionResult::new(
                &request,
                "error",
                "未注册的 Agent 工具；未执行任何操作",
                true,
            );
        }
        let mut lease = match self.begin(&request) {
            Ok(lease) => lease,
            Err(result) => return result,
        };
        let validated = match validate_request(&request) {
            Ok(validated) => validated,
            Err(result) => return lease.finish(result),
        };
        let deadline = tokio::time::Instant::now() + validated.timeout;
        let mut result = {
            let operation = adapter(validated.invocation, lease.cancellation.clone());
            tokio::pin!(operation);
            tokio::select! {
                biased;
                _ = lease.cancellation.cancelled() => ToolExecutionResult::new(&request, "cancelled", interrupted_message(&request.name, false), true),
                _ = tokio::time::sleep_until(deadline) => ToolExecutionResult::new(&request, "timeout", interrupted_message(&request.name, true), true),
                outcome = &mut operation => match outcome {
                    Ok((content, is_error)) => ToolExecutionResult::new(&request, if is_error { "error" } else { "completed" }, content, is_error),
                    Err(error) if error.starts_with("denied|") => ToolExecutionResult::new(&request, "denied", error.trim_start_matches("denied|"), true),
                    Err(error) => ToolExecutionResult::new(&request, "error", error, true),
                },
            }
        }; // Drop the operation (and cleanup guards) before publishing completion.
           // Synchronous checked writes can exceed a deadline inside one poll.
           // Report that honestly even when the timer could not be polled meanwhile.
        if tokio::time::Instant::now() >= deadline
            && matches!(result.status.as_str(), "completed" | "error")
        {
            result = ToolExecutionResult::new(
                &request,
                "timeout",
                interrupted_message(&request.name, true),
                true,
            );
        }
        lease.finish(result)
    }
}

fn interrupted_message(name: &str, timeout: bool) -> String {
    let reason = if timeout {
        "工具执行超时"
    } else {
        "工具执行已取消"
    };
    let detail = match name {
        "run_terminal_command" => "本地子进程将被终止；远程 SSH 通道将请求关闭，但不能保证远端进程或其子进程停止。已产生的副作用不能撤销，执行结果未知",
        "call_mcp_tool" => "已停止等待 MCP 请求；远端可能已经执行，不能撤销，执行结果未知",
        _ => "已停止等待文件操作；已经提交的写入不能撤销，文件状态可能已变化，请重新读取确认",
    };
    format!("{reason}；{detail}")
}

struct ExecutionLease<'a> {
    tracker: &'a ExecutionTracker,
    request: ExecuteToolRequest,
    cancellation: Arc<Cancellation>,
    finished: bool,
}

impl ExecutionLease<'_> {
    fn finish(&mut self, mut result: ToolExecutionResult) -> ToolExecutionResult {
        let mut tracking = self
            .tracker
            .tracking
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Serialize completion with cancel(): cancellation that won the lock
        // before completion cannot be overwritten by a concurrently ready result.
        if self.cancellation.is_cancelled()
            && matches!(result.status.as_str(), "completed" | "error")
        {
            result = ToolExecutionResult::new(
                &self.request,
                "cancelled",
                interrupted_message(&self.request.name, false),
                true,
            );
        }
        tracking.entries.insert(
            self.request.tool_call_id.clone(),
            Entry::Finished {
                status: result.status.clone(),
            },
        );
        tracking
            .inactive
            .push_back(self.request.tool_call_id.clone());
        self.finished = true;
        result
    }
}

impl Drop for ExecutionLease<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.cancellation.cancel();
            self.finish(ToolExecutionResult::new(
                &self.request,
                "cancelled",
                "工具执行等待被终止；执行结果未知，请确认目标状态",
                true,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn request(id: &str) -> ExecuteToolRequest {
        ExecuteToolRequest {
            tool_id: None,
            tool_call_id: id.into(),
            name: "call_mcp_tool".into(),
            arguments: json!({"server":"server-1","tool":"test","arguments":{}}),
            approved: true,
            execution_intent: ExecutionIntent::ApproveOnce,
            timeout_ms: Some(1000),
            conversation_id: None,
            agent_id: None,
            step_index: None,
        }
    }

    #[test]
    fn sequential_file_edits_require_unique_matches_and_change() {
        let edits = vec![json!({"search":"one", "replace":"ONE"})];
        assert_eq!(apply_file_edits("one two", &edits).unwrap(), "ONE two");
        assert!(apply_file_edits("one one", &edits)
            .unwrap_err()
            .contains("AMBIGUOUS"));
        assert!(apply_file_edits("two", &edits)
            .unwrap_err()
            .contains("STALE"));
        assert!(
            apply_file_edits("one", &[json!({"search":"one", "replace":"one"})])
                .unwrap_err()
                .contains("NO_CHANGE")
        );
        assert!(apply_file_edits(
            "one one",
            &[
                json!({"search":"one", "replace":"ONE"}),
                json!({"search":"one", "replace":"TWO"})
            ]
        )
        .is_err());
    }

    #[test]
    fn unknown_file_edit_fields_are_rejected() {
        let result: Result<FileEditArguments, _> = serde_json::from_value(json!({
            "path":"/tmp/file", "original_content":"a", "new_content":"b", "authorization_identity":"client"
        }));
        assert!(result.is_err());
    }

    #[test]
    fn registry_has_complete_model_schemas() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 3);
        for definition in &definitions {
            assert_eq!(definition.permission, PermissionDecision::Ask);
            for key in definition.input_schema["required"].as_array().unwrap() {
                assert!(definition.input_schema["properties"]
                    .get(key.as_str().unwrap())
                    .is_some());
            }
        }
        assert_eq!(
            definitions[0].input_schema["required"],
            json!(["summary", "context_source", "command"])
        );
        assert!(definitions[1].input_schema["properties"]
            .get("target_source")
            .is_some());
        assert_eq!(openai_specs().len(), 3);
    }

    #[test]
    fn permission_policy_matrix_is_fail_closed() {
        for kind in [ToolKind::Terminal, ToolKind::FileEdit, ToolKind::Mcp] {
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Ask,
                    kind,
                    ExecutionIntent::Automatic,
                    true
                ),
                PermissionDecision::Deny
            );
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Ask,
                    kind,
                    ExecutionIntent::ApproveOnce,
                    false
                ),
                PermissionDecision::Allow
            );
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Allowlist,
                    kind,
                    ExecutionIntent::Automatic,
                    false
                ),
                PermissionDecision::Deny
            );
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Allowlist,
                    kind,
                    ExecutionIntent::Automatic,
                    true
                ),
                PermissionDecision::Allow
            );
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Allowlist,
                    kind,
                    ExecutionIntent::ApproveOnce,
                    true
                ),
                PermissionDecision::Deny
            );
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Full,
                    kind,
                    ExecutionIntent::Automatic,
                    false
                ),
                PermissionDecision::Allow
            );
        }
        assert_eq!(
            evaluate_policy(
                AiPermissionPolicy::Edit,
                ToolKind::FileEdit,
                ExecutionIntent::Automatic,
                false,
            ),
            PermissionDecision::Allow
        );
        for kind in [ToolKind::Terminal, ToolKind::Mcp] {
            assert_eq!(
                evaluate_policy(
                    AiPermissionPolicy::Edit,
                    kind,
                    ExecutionIntent::Automatic,
                    true
                ),
                PermissionDecision::Deny
            );
        }
    }

    #[test]
    fn policy_is_fail_closed() {
        assert_eq!(
            decide("call_mcp_tool", false, false, false).unwrap(),
            PermissionDecision::Deny
        );
        assert_eq!(
            decide("call_mcp_tool", true, true, false).unwrap(),
            PermissionDecision::Deny
        );
        assert_eq!(
            decide("call_mcp_tool", true, false, true).unwrap(),
            PermissionDecision::Deny
        );
        assert!(decide("unknown", true, false, false).is_err());
        let parsed: ExecuteToolRequest = serde_json::from_value(
            json!({"tool_call_id":"id","name":"call_mcp_tool","arguments":{}}),
        )
        .unwrap();
        assert!(!parsed.approved);
    }

    #[test]
    fn raw_file_proposals_cannot_execute() {
        let mut req = request("edit");
        req.name = "propose_file_edit".into();
        req.arguments = json!({"summary":"change","target_source":"file-1","edits":[{"search":"a","replace":"b"}]});
        assert!(validate_request(&req).is_err());
        req.arguments = json!({"path":"file.txt","original_content":"a","new_content":"b"});
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn timeout_and_target_validation() {
        let mut req = request("terminal");
        req.name = "run_terminal_command".into();
        req.arguments = json!({"terminal_id":uuid::Uuid::nil().to_string(),"command":"echo ok","timeout_ms":3000});
        for value in [2999, 30001] {
            req.timeout_ms = Some(value);
            assert!(validate_request(&req).is_err());
        }
        req.timeout_ms = Some(3000);
        assert!(validate_request(&req).is_ok());
        req.arguments["terminal_id"] = json!("invalid");
        assert!(validate_request(&req).is_err());
        let mut req = request("mcp");
        req.timeout_ms = Some(120001);
        assert!(validate_request(&req).is_err());
        req.timeout_ms = Some(0);
        assert!(validate_request(&req).is_err());
        assert!(validate_tool_call_id("bad id").is_err());
    }

    #[tokio::test]
    async fn denied_unknown_invalid_have_no_side_effects() {
        let tracker = ExecutionTracker::default();
        let count = AtomicUsize::new(0);
        for (id, name, approved) in [
            ("unknown", "unknown", true),
            ("bad id", "call_mcp_tool", true),
        ] {
            let mut req = request(id);
            req.name = name.into();
            req.approved = approved;
            let result = tracker
                .execute(req, |_, _| async {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(("bad".into(), false))
                })
                .await;
            assert!(result.is_error);
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_before_start_is_retained() {
        let tracker = ExecutionTracker::default();
        tracker.cancel("before").unwrap();
        let result = tracker
            .execute(request("before"), |_, _| async {
                panic!("must not execute")
            })
            .await;
        assert_eq!(result.status, "cancelled");
        assert!(result.is_error);
    }

    #[tokio::test]
    async fn cancellation_notification_has_no_registration_race() {
        for _ in 0..100 {
            let token = Arc::new(Cancellation::default());
            let waiter_token = token.clone();
            let waiter = tokio::spawn(async move { waiter_token.cancelled().await });
            tokio::task::yield_now().await;
            token.cancel();
            tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn running_cancellation_and_duplicate_are_safe() {
        let tracker = Arc::new(ExecutionTracker::default());
        let started = Arc::new(Notify::new());
        let run_tracker = tracker.clone();
        let run_started = started.clone();
        let run = tokio::spawn(async move {
            run_tracker
                .execute(request("running"), |_, _| async move {
                    run_started.notify_one();
                    std::future::pending().await
                })
                .await
        });
        started.notified().await;
        let duplicate = tracker
            .execute(request("running"), |_, _| async {
                panic!("duplicate must not execute")
            })
            .await;
        assert_eq!(duplicate.status, "error");
        tracker.cancel("running").unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status, "cancelled");
        assert!(result.content.contains("未知"));
    }

    #[tokio::test]
    async fn completed_and_failed_calls_never_rerun() {
        let tracker = ExecutionTracker::default();
        for fail in [false, true] {
            let id = if fail { "failed" } else { "completed" };
            let result = tracker
                .execute(request(id), |_, _| async move {
                    if fail {
                        Err("failure".into())
                    } else {
                        Ok(("ok".into(), false))
                    }
                })
                .await;
            assert_eq!(result.is_error, fail);
            let duplicate = tracker
                .execute(request(id), |_, _| async { panic!("must not rerun") })
                .await;
            assert!(duplicate.is_error);
        }
    }

    #[tokio::test]
    async fn timeout_drops_adapter_and_reports_unknown_result() {
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let tracker = ExecutionTracker::default();
        let flag = Arc::new(AtomicBool::new(false));
        let mut req = request("timeout");
        req.timeout_ms = Some(1);
        let result = tracker
            .execute(req, |_, _| async {
                let _guard = DropFlag(flag.clone());
                std::future::pending().await
            })
            .await;
        assert_eq!(result.status, "timeout");
        assert!(result.is_error && result.content.contains("未知"));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn abandoned_execution_does_not_stay_running() {
        let tracker = Arc::new(ExecutionTracker::default());
        let started = Arc::new(Notify::new());
        let run_tracker = tracker.clone();
        let run_started = started.clone();
        let task = tokio::spawn(async move {
            run_tracker
                .execute(request("abandoned"), |_, _| async move {
                    run_started.notify_one();
                    std::future::pending().await
                })
                .await
        });
        started.notified().await;
        task.abort();
        let _ = task.await;
        let tracking = tracker.tracking.lock().unwrap();
        assert!(matches!(
            tracking.entries.get("abandoned"),
            Some(Entry::Finished { .. })
        ));
    }

    #[tokio::test]
    async fn cancellation_and_deadline_winning_during_the_final_poll_are_not_success() {
        let tracker = ExecutionTracker::default();
        let result = tracker
            .execute(request("cancel-in-poll"), |_, cancellation| async move {
                cancellation.cancel();
                Ok(("not success".into(), false))
            })
            .await;
        assert_eq!(result.status, "cancelled");
        let mut req = request("timeout-in-poll");
        req.timeout_ms = Some(1);
        let result = tracker
            .execute(req, |_, _| async {
                std::thread::sleep(Duration::from_millis(5));
                Ok(("not success".into(), false))
            })
            .await;
        assert_eq!(result.status, "timeout");
        assert!(result.is_error);
    }

    #[tokio::test]
    async fn tracking_and_utf8_results_are_bounded() {
        let tracker = ExecutionTracker::default();
        for i in 0..(MAX_TRACKED_EXECUTIONS * 2) {
            tracker.cancel(&format!("cancel-{i}")).unwrap();
        }
        assert_eq!(
            tracker.tracking.lock().unwrap().entries.len(),
            MAX_TRACKED_EXECUTIONS
        );
        let result = tracker
            .execute(request("large"), |_, _| async {
                Ok(("字".repeat(MAX_RESULT_BYTES), false))
            })
            .await;
        assert!(result.content.len() < MAX_RESULT_BYTES + 100);
        assert!(result.content.contains("截断"));
    }
}
