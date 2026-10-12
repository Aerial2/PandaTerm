use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) const AI_CONVERSATION_VERSION: u8 = 2;
const MAX_NODES: usize = 500;
const MAX_CONTENT_CHARS: usize = 2_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiConversationStore {
    pub(crate) version: u8,
    pub(crate) conversations: Vec<AiConversation>,
}

impl Default for AiConversationStore {
    fn default() -> Self {
        Self {
            version: AI_CONVERSATION_VERSION,
            conversations: Vec::new(),
        }
    }
}

fn default_ai_conversation_mode() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiConversation {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default = "default_ai_conversation_mode")]
    pub(crate) mode: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) messages: Vec<AiStoredMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tree: Option<AiConversationTree>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiConversationTree {
    pub(crate) nodes: Vec<AiConversationNode>,
    pub(crate) active_leaf_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiConversationNode {
    pub(crate) id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) message: AiStoredMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiStoredMessage {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) contexts: Vec<AiStoredContext>,
    #[serde(default)]
    pub(crate) actions: Vec<AiStoredAction>,
    pub(crate) created_at: String,
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tool_calls: Option<Vec<AiStoredToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<AiStoredUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiStoredToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiStoredUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum AiStoredAction {
    Edit {
        id: String,
        summary: String,
        target_source: String,
        target_label: String,
        status: String,
        edits: Vec<AiStoredEditOperation>,
        #[serde(default)]
        is_remote: bool,
        terminal_id: Option<String>,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        created_at: String,
    },
    Terminal {
        id: String,
        summary: String,
        context_source: String,
        context_label: String,
        command: String,
        timeout_ms: u64,
        status: String,
        is_remote: bool,
        terminal_id: String,
        output: Option<String>,
        exit_code: Option<i32>,
        #[serde(default)]
        truncated: bool,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        tool_call_id: Option<String>,
        created_at: String,
    },
    Mcp {
        id: String,
        summary: String,
        server_id: String,
        tool_name: String,
        #[serde(default)]
        arguments: Value,
        status: String,
        content: Option<String>,
        #[serde(default)]
        is_error: bool,
        error: Option<String>,
        #[serde(default)]
        continued: bool,
        tool_call_id: Option<String>,
        created_at: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiStoredEditOperation {
    pub(crate) search: String,
    pub(crate) replace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AiStoredContext {
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) source: Option<String>,
}

fn validate_ai_stored_action(action: &AiStoredAction) -> Result<usize, String> {
    let serialized =
        serde_json::to_string(action).map_err(|error| format!("AI 动作记录序列化失败：{error}"))?;
    let chars = serialized.chars().count();
    if chars > 256_000 {
        return Err("单个 AI 动作记录不能超过 256000 个字符".to_string());
    }

    match action {
        AiStoredAction::Edit {
            id,
            summary,
            target_source,
            target_label,
            status,
            edits,
            terminal_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || target_source.trim().is_empty()
                || target_source.chars().count() > 1_024
                || target_label.chars().count() > 260
                || !matches!(
                    status.as_str(),
                    "proposed"
                        | "reading"
                        | "ready"
                        | "applying"
                        | "applied"
                        | "rejected"
                        | "stale"
                        | "error"
                )
                || edits.is_empty()
                || edits.len() > 20
                || edits.iter().any(|edit| {
                    edit.search.is_empty()
                        || edit.search.chars().count() > 100_000
                        || edit.replace.chars().count() > 100_000
                })
                || terminal_id
                    .as_ref()
                    .is_some_and(|terminal_id| terminal_id.len() > 100)
                || created_at.len() > 64
            {
                return Err("AI 文件修改动作记录无效".to_string());
            }
        }
        AiStoredAction::Terminal {
            id,
            summary,
            context_source,
            context_label,
            command,
            timeout_ms,
            status,
            terminal_id,
            tool_call_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || context_source.trim().is_empty()
                || context_source.chars().count() > 1_024
                || context_label.chars().count() > 260
                || command.trim().is_empty()
                || command.chars().count() > 4_000
                || !(3_000..=30_000).contains(timeout_ms)
                || !matches!(
                    status.as_str(),
                    "proposed" | "running" | "completed" | "rejected" | "timeout" | "error"
                )
                || terminal_id.is_empty()
                || terminal_id.len() > 100
                || tool_call_id
                    .as_ref()
                    .is_some_and(|tool_call_id| tool_call_id.len() > 200)
                || created_at.len() > 64
            {
                return Err("AI 终端动作记录无效".to_string());
            }
        }
        AiStoredAction::Mcp {
            id,
            summary,
            server_id,
            tool_name,
            arguments,
            status,
            tool_call_id,
            created_at,
            ..
        } => {
            if id.is_empty()
                || id.len() > 100
                || summary.trim().is_empty()
                || summary.chars().count() > 500
                || server_id.trim().is_empty()
                || server_id.chars().count() > 200
                || tool_name.trim().is_empty()
                || tool_name.chars().count() > 200
                || !arguments.is_object()
                || !matches!(
                    status.as_str(),
                    "proposed" | "running" | "completed" | "rejected" | "error"
                )
                || tool_call_id
                    .as_ref()
                    .is_some_and(|tool_call_id| tool_call_id.len() > 200)
                || created_at.len() > 64
            {
                return Err("AI MCP 动作记录无效".to_string());
            }
        }
    }
    Ok(chars)
}

fn valid_message_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 100
}

fn validate_message(message: &AiStoredMessage) -> Result<usize, String> {
    if !valid_message_id(&message.id) {
        return Err("AI 会话消息 ID 无效".to_string());
    }
    if !matches!(message.role.as_str(), "user" | "assistant") {
        return Err("AI 会话消息角色无效".to_string());
    }
    // Checkpoints may be saved while a response is in flight. Recovery changes these
    // states to cancelled/error; it never replays a tool or invents its result.
    if !matches!(
        message.status.as_str(),
        "complete" | "cancelled" | "error" | "streaming" | "pending" | "running" | "interrupted"
    ) {
        return Err("AI 会话消息状态无效".to_string());
    }
    if message.created_at.len() > 64 || message.content.chars().count() > 64_000 {
        return Err("单条 AI 会话消息过长或时间无效".to_string());
    }
    if message.contexts.len() > 20
        || message.contexts.iter().any(|context| {
            !matches!(context.kind.as_str(), "terminal" | "selection" | "file")
                || context.label.chars().count() > 260
                || context
                    .source
                    .as_ref()
                    .is_some_and(|source| source.chars().count() > 1_024)
        })
    {
        return Err("AI 会话上下文引用过多或无效".to_string());
    }
    if message.actions.len() > 20 {
        return Err("单条 AI 会话消息最多保存 20 个动作".to_string());
    }
    let mut action_ids = HashSet::new();
    let action_chars = message.actions.iter().try_fold(0usize, |total, action| {
        let id = match action {
            AiStoredAction::Edit { id, .. }
            | AiStoredAction::Terminal { id, .. }
            | AiStoredAction::Mcp { id, .. } => id,
        };
        if !action_ids.insert(id) {
            return Err("AI 会话动作 ID 重复".to_string());
        }
        validate_ai_stored_action(action).map(|chars| total.saturating_add(chars))
    })?;
    if action_chars > 512_000 {
        return Err("单条 AI 会话消息的动作记录不能超过 512000 个字符".to_string());
    }
    if let Some(calls) = &message.tool_calls {
        let mut ids = HashSet::new();
        if calls.len() > 20
            || calls.iter().any(|call| {
                call.id.is_empty()
                    || call.id.len() > 200
                    || !ids.insert(&call.id)
                    || call.name.trim().is_empty()
                    || call.name.chars().count() > 200
                    || call.arguments.chars().count() > 256_000
            })
        {
            return Err("AI 会话工具调用记录无效".to_string());
        }
    }
    // Include contexts, timestamps, tool arguments and usage as well as content/actions.
    serde_json::to_string(message)
        .map(|json| json.chars().count())
        .map_err(|error| format!("AI 会话消息序列化失败：{error}"))
}

fn validate_tree(tree: &AiConversationTree) -> Result<(), String> {
    if tree.nodes.len() > MAX_NODES {
        return Err("单个 AI 会话最多保存 500 个消息节点（包括非活跃分支）".to_string());
    }
    let mut nodes = HashMap::new();
    let mut total_chars = 0usize;
    for node in &tree.nodes {
        if node.id != node.message.id || !valid_message_id(&node.id) {
            return Err("AI 会话树节点 ID 必须与消息 ID 一致".to_string());
        }
        if nodes.insert(node.id.as_str(), node).is_some() {
            return Err("AI 会话树节点 ID 重复".to_string());
        }
        total_chars = total_chars.saturating_add(validate_message(&node.message)?);
    }
    if total_chars > MAX_CONTENT_CHARS {
        return Err("单个 AI 会话内容不能超过 2000000 个字符（包括非活跃分支）".to_string());
    }
    if tree
        .active_leaf_id
        .as_ref()
        .is_some_and(|id| !nodes.contains_key(id.as_str()))
    {
        return Err("AI 会话树活跃节点不存在".to_string());
    }
    for node in &tree.nodes {
        if node
            .parent_id
            .as_ref()
            .is_some_and(|id| !nodes.contains_key(id.as_str()))
        {
            return Err("AI 会话树父节点不存在".to_string());
        }
    }
    for node in &tree.nodes {
        let mut visited = HashSet::new();
        let mut current = Some(node.id.as_str());
        while let Some(id) = current {
            if !visited.insert(id) {
                return Err("AI 会话树存在循环".to_string());
            }
            current = nodes[id].parent_id.as_deref();
        }
    }
    Ok(())
}

fn linear_tree(messages: &[AiStoredMessage]) -> AiConversationTree {
    AiConversationTree {
        nodes: messages
            .iter()
            .enumerate()
            .map(|(index, message)| AiConversationNode {
                id: message.id.clone(),
                parent_id: index
                    .checked_sub(1)
                    .map(|previous| messages[previous].id.clone()),
                message: message.clone(),
            })
            .collect(),
        active_leaf_id: messages.last().map(|message| message.id.clone()),
    }
}

fn active_path(tree: &AiConversationTree) -> Vec<AiStoredMessage> {
    // Callers validate first, including disconnected branches and cycles.
    let nodes: HashMap<_, _> = tree
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut path = Vec::new();
    let mut current = tree.active_leaf_id.as_deref();
    while let Some(id) = current {
        let node = nodes[id];
        path.push(node.message.clone());
        current = node.parent_id.as_deref();
    }
    path.reverse();
    path
}

pub(crate) fn validate_ai_conversation(conversation: &AiConversation) -> Result<(), String> {
    Uuid::parse_str(&conversation.id).map_err(|_| "AI 会话 ID 无效".to_string())?;
    let title = conversation.title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("AI 会话标题必须为 1 到 120 个字符".to_string());
    }
    if !matches!(conversation.mode.as_str(), "ask" | "agent") {
        return Err("AI 会话模式无效".to_string());
    }
    if conversation.created_at.len() > 64 || conversation.updated_at.len() > 64 {
        return Err("AI 会话时间无效".to_string());
    }
    if conversation.messages.len() > MAX_NODES {
        return Err("单个 AI 会话最多保存 500 条消息".to_string());
    }
    // Validate a supplied projection too, but the tree is authoritative. A stale
    // projection is regenerated, rather than erasing the inactive branches.
    validate_tree(&linear_tree(&conversation.messages))?;
    if let Some(tree) = &conversation.tree {
        validate_tree(tree)?;
    }
    Ok(())
}

pub(crate) fn normalize_conversation(conversation: &mut AiConversation) -> Result<(), String> {
    validate_ai_conversation(conversation)?;
    let tree = conversation
        .tree
        .get_or_insert_with(|| linear_tree(&conversation.messages));
    conversation.messages = active_path(tree);
    Ok(())
}

fn recover_message(message: &mut AiStoredMessage) {
    if matches!(
        message.status.as_str(),
        "streaming" | "pending" | "running" | "interrupted"
    ) {
        message.status = "cancelled".to_string();
    }
    for action in &mut message.actions {
        match action {
            AiStoredAction::Edit {
                status,
                error,
                continued,
                ..
            } if matches!(status.as_str(), "reading" | "applying") => {
                *status = "error".to_string();
                *continued = false;
                error.get_or_insert_with(|| {
                    "应用已中断；执行结果未知，请检查文件后再操作".to_string()
                });
            }
            AiStoredAction::Terminal {
                status,
                error,
                continued,
                exit_code,
                ..
            } if status == "running" => {
                *status = "error".to_string();
                *continued = false;
                *exit_code = None;
                error.get_or_insert_with(|| "应用已中断；命令执行结果未知，未自动重试".to_string());
            }
            AiStoredAction::Mcp {
                status,
                error,
                continued,
                is_error,
                ..
            } if status == "running" => {
                *status = "error".to_string();
                *continued = false;
                *is_error = true;
                error.get_or_insert_with(|| "应用已中断；工具执行结果未知，未自动重试".to_string());
            }
            _ => {}
        }
    }
}

pub(crate) fn decode_store(content: &str) -> Result<AiConversationStore, String> {
    let mut store: AiConversationStore = serde_json::from_str(content)
        .map_err(|error| format!("AI 会话记录已损坏，已拒绝覆盖原文件：{error}"))?;
    if !matches!(store.version, 1 | AI_CONVERSATION_VERSION) {
        return Err(format!("不支持的 AI 会话记录版本：{}", store.version));
    }
    if store.conversations.len() > 100 {
        return Err("最多保存 100 个 AI 会话".to_string());
    }
    let mut ids = HashSet::new();
    for conversation in &mut store.conversations {
        if !ids.insert(conversation.id.clone()) {
            return Err("AI 会话 ID 重复".to_string());
        }
        normalize_conversation(conversation)?;
        if let Some(tree) = &mut conversation.tree {
            for node in &mut tree.nodes {
                recover_message(&mut node.message);
            }
            conversation.messages = active_path(tree);
        }
    }
    store.version = AI_CONVERSATION_VERSION;
    Ok(store)
}

pub(crate) fn encode_store(store: &AiConversationStore) -> Result<String, String> {
    let mut normalized = store.clone();
    normalized.version = AI_CONVERSATION_VERSION;
    if normalized.conversations.len() > 100 {
        return Err("最多保存 100 个 AI 会话".to_string());
    }
    let mut ids = HashSet::new();
    for conversation in &mut normalized.conversations {
        if !ids.insert(conversation.id.clone()) {
            return Err("AI 会话 ID 重复".to_string());
        }
        normalize_conversation(conversation)?;
    }
    serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("AI 会话记录序列化失败：{error}"))
}

pub(crate) fn upsert_conversation(
    store: &mut AiConversationStore,
    mut incoming: AiConversation,
) -> Result<(), String> {
    normalize_conversation(&mut incoming)?;
    if let Some(index) = store
        .conversations
        .iter()
        .position(|item| item.id == incoming.id)
    {
        let mut existing = store.conversations[index].clone();
        normalize_conversation(&mut existing)?;
        let tree = incoming.tree.as_mut().expect("normalized tree");
        let existing_tree = existing.tree.as_ref().expect("normalized tree");
        for old_node in &existing_tree.nodes {
            if let Some(node) = tree.nodes.iter_mut().find(|node| node.id == old_node.id) {
                if node.parent_id != old_node.parent_id {
                    return Err("AI 会话历史节点不能更换父节点；新分支请使用新消息 ID".to_string());
                }
                // Legacy clients omit native call/usage fields. Retain those records.
                if node.message.tool_calls.is_none() {
                    node.message.tool_calls = old_node.message.tool_calls.clone();
                }
                if node.message.usage.is_none() {
                    node.message.usage = old_node.message.usage.clone();
                }
                // Missing old action records are history, not a request to delete them.
                for old_action in &old_node.message.actions {
                    let action_id = |action: &AiStoredAction| match action {
                        AiStoredAction::Edit { id, .. }
                        | AiStoredAction::Terminal { id, .. }
                        | AiStoredAction::Mcp { id, .. } => id.clone(),
                    };
                    if !node
                        .message
                        .actions
                        .iter()
                        .any(|action| action_id(action) == action_id(old_action))
                    {
                        node.message.actions.push(old_action.clone());
                    }
                }
            } else {
                tree.nodes.push(old_node.clone());
            }
        }
        normalize_conversation(&mut incoming)?;
        store.conversations[index] = incoming;
    } else {
        if store.conversations.len() >= 100 {
            return Err("最多保存 100 个 AI 会话，请先删除旧会话".to_string());
        }
        store.conversations.insert(0, incoming);
    }
    store.version = AI_CONVERSATION_VERSION;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(id: &str) -> AiStoredMessage {
        serde_json::from_value(json!({
            "id": id, "role": "assistant", "content": format!("content-{id}"),
            "contexts": [], "created_at": "2026-10-10T00:00:00Z", "status": "complete"
        }))
        .unwrap()
    }

    fn conversation() -> AiConversation {
        serde_json::from_value(json!({
            "id": "00000000-0000-0000-0000-000000000001", "title": "session",
            "created_at": "2026-10-10T00:00:00Z", "updated_at": "2026-10-10T00:00:00Z",
            "messages": [message("root"), message("old")]
        }))
        .unwrap()
    }

    fn branch() -> AiConversation {
        let mut result = conversation();
        normalize_conversation(&mut result).unwrap();
        let tree = result.tree.as_mut().unwrap();
        tree.nodes.push(AiConversationNode {
            id: "new".into(),
            parent_id: Some("root".into()),
            message: message("new"),
        });
        tree.active_leaf_id = Some("new".into());
        normalize_conversation(&mut result).unwrap();
        result
    }

    fn mcp(status: &str) -> AiStoredAction {
        serde_json::from_value(json!({
            "kind": "mcp", "id": "mcp-1", "summary": "lookup", "server_id": "docs",
            "tool_name": "search", "arguments": {"query": "hello"}, "status": status,
            "content": "partial tool result", "is_error": false, "error": null,
            "continued": true, "tool_call_id": "call-1", "created_at": "2026-10-10"
        }))
        .unwrap()
    }

    fn store_json(version: u8, conversation: &AiConversation) -> String {
        serde_json::to_string(&json!({"version": version, "conversations": [conversation]}))
            .unwrap()
    }

    fn path_ids(conversation: &AiConversation) -> Vec<&str> {
        conversation
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect()
    }

    #[test]
    fn legacy_v1_migrates_to_v2_without_losing_tool_results() {
        let mut legacy = conversation();
        legacy.messages[1].actions.push(mcp("completed"));
        let before = serde_json::to_value(&legacy.messages).unwrap();
        let store = decode_store(&store_json(1, &legacy)).unwrap();
        assert_eq!(store.version, 2);
        let migrated = &store.conversations[0];
        assert_eq!(migrated.mode, "ask");
        assert_eq!(serde_json::to_value(&migrated.messages).unwrap(), before);
        let tree = migrated.tree.as_ref().unwrap();
        assert_eq!(tree.nodes.len(), 2);
        assert_eq!(tree.nodes[1].parent_id.as_deref(), Some("root"));
        assert_eq!(tree.active_leaf_id.as_deref(), Some("old"));
        let encoded = encode_store(&store).unwrap();
        let reloaded = decode_store(&encoded).unwrap();
        assert_eq!(
            serde_json::to_value(&reloaded.conversations[0]).unwrap(),
            serde_json::to_value(migrated).unwrap()
        );
    }

    #[test]
    fn legacy_v2_without_tree_also_migrates() {
        let store = decode_store(&store_json(2, &conversation())).unwrap();
        assert!(store.conversations[0].tree.is_some());
    }

    #[test]
    fn branch_switch_projects_active_path_and_keeps_all_nodes() {
        let mut conversation = branch();
        assert_eq!(path_ids(&conversation), ["root", "new"]);
        conversation.tree.as_mut().unwrap().active_leaf_id = Some("old".into());
        normalize_conversation(&mut conversation).unwrap();
        assert_eq!(path_ids(&conversation), ["root", "old"]);
        let reloaded = decode_store(&store_json(2, &conversation)).unwrap();
        assert_eq!(
            reloaded.conversations[0].tree.as_ref().unwrap().nodes.len(),
            3
        );
    }

    #[test]
    fn partial_tree_snapshot_preserves_omitted_branch() {
        let mut store = AiConversationStore {
            version: 2,
            conversations: vec![branch()],
        };
        let mut snapshot = store.conversations[0].clone();
        snapshot
            .tree
            .as_mut()
            .unwrap()
            .nodes
            .retain(|node| node.id != "old");
        upsert_conversation(&mut store, snapshot).unwrap();
        assert_eq!(store.conversations[0].tree.as_ref().unwrap().nodes.len(), 3);
        assert_eq!(path_ids(&store.conversations[0]), ["root", "new"]);
    }

    #[test]
    fn legacy_save_preserves_inactive_branches_and_new_metadata() {
        let mut existing = branch();
        let root = &mut existing.tree.as_mut().unwrap().nodes[0].message;
        root.actions.push(mcp("completed"));
        root.tool_calls = Some(vec![AiStoredToolCall {
            id: "call-1".into(),
            name: "search".into(),
            arguments: "{}".into(),
        }]);
        root.usage = Some(AiStoredUsage {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
            cache_read_tokens: None,
            cache_write_tokens: None,
        });
        normalize_conversation(&mut existing).unwrap();
        let mut legacy = existing.clone();
        legacy.tree = None;
        legacy.messages[0].actions.clear();
        legacy.messages[0].tool_calls = None;
        legacy.messages[0].usage = None;
        legacy.messages.push(message("next"));
        let mut store = AiConversationStore {
            version: 2,
            conversations: vec![existing],
        };
        upsert_conversation(&mut store, legacy).unwrap();
        let saved = &store.conversations[0];
        assert_eq!(saved.tree.as_ref().unwrap().nodes.len(), 4);
        assert_eq!(path_ids(saved), ["root", "new", "next"]);
        assert_eq!(saved.messages[0].actions.len(), 1);
        assert!(saved.messages[0].tool_calls.is_some());
        assert_eq!(saved.messages[0].usage.as_ref().unwrap().total_tokens, 3);
    }

    #[test]
    fn existing_node_cannot_be_reparented_and_failed_merge_is_transactional() {
        let original = branch();
        let mut store = AiConversationStore {
            version: 2,
            conversations: vec![original.clone()],
        };
        let mut changed = original;
        changed.tree.as_mut().unwrap().nodes[1].parent_id = Some("new".into());
        let before = serde_json::to_value(&store).unwrap();
        assert!(upsert_conversation(&mut store, changed)
            .unwrap_err()
            .contains("父节点"));
        assert_eq!(serde_json::to_value(&store).unwrap(), before);
    }

    #[test]
    fn rejects_duplicate_node_ids_and_mismatched_message_id() {
        let mut conversation = branch();
        let duplicate = conversation.tree.as_ref().unwrap().nodes[0].clone();
        conversation.tree.as_mut().unwrap().nodes.push(duplicate);
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("重复"));
        conversation.tree.as_mut().unwrap().nodes.pop();
        conversation.tree.as_mut().unwrap().nodes[0].message.id = "different".into();
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("一致"));
    }

    #[test]
    fn rejects_duplicate_legacy_message_ids() {
        let mut legacy = conversation();
        legacy.messages[1].id = "root".into();
        assert!(decode_store(&store_json(1, &legacy))
            .unwrap_err()
            .contains("重复"));
    }

    #[test]
    fn rejects_missing_direct_and_indirect_parents_without_panicking() {
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        tree.nodes[0].parent_id = Some("new".into());
        tree.nodes[2].parent_id = Some("missing".into());
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("父节点不存在"));
    }

    #[test]
    fn rejects_cycles_even_in_inactive_components() {
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        tree.nodes[1].parent_id = Some("old".into());
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("循环"));
        tree_reset_cycle(&mut conversation);
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("循环"));
    }

    fn tree_reset_cycle(conversation: &mut AiConversation) {
        let tree = conversation.tree.as_mut().unwrap();
        tree.nodes[0].parent_id = Some("new".into());
        tree.nodes[1].parent_id = Some("root".into());
    }

    #[test]
    fn rejects_missing_active_leaf() {
        let mut conversation = branch();
        conversation.tree.as_mut().unwrap().active_leaf_id = Some("missing".into());
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("活跃节点不存在"));
    }

    #[test]
    fn empty_and_unselected_tree_project_empty_path_without_erasing_history() {
        let mut conversation = branch();
        conversation.tree.as_mut().unwrap().active_leaf_id = None;
        normalize_conversation(&mut conversation).unwrap();
        assert!(conversation.messages.is_empty());
        assert_eq!(conversation.tree.as_ref().unwrap().nodes.len(), 3);
        conversation.tree = None;
        normalize_conversation(&mut conversation).unwrap();
        assert!(conversation.tree.as_ref().unwrap().nodes.is_empty());
    }

    #[test]
    fn active_tip_can_be_internal_node_for_rewind_and_branch_creation() {
        let mut conversation = branch();
        conversation.tree.as_mut().unwrap().active_leaf_id = Some("root".into());
        normalize_conversation(&mut conversation).unwrap();
        assert_eq!(path_ids(&conversation), ["root"]);
        assert_eq!(conversation.tree.as_ref().unwrap().nodes.len(), 3);
    }

    #[test]
    fn all_branches_count_towards_node_limit() {
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        for index in 0..498 {
            let id = format!("inactive-{index}");
            tree.nodes.push(AiConversationNode {
                id: id.clone(),
                parent_id: Some("root".into()),
                message: message(&id),
            });
        }
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("500"));
    }

    #[test]
    fn inactive_content_and_tool_arguments_count_towards_total_limit() {
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        for index in 0..32 {
            let id = format!("inactive-{index}");
            let mut message = message(&id);
            message.content = "x".repeat(63_000);
            tree.nodes.push(AiConversationNode {
                id,
                parent_id: Some("root".into()),
                message,
            });
        }
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("2000000"));
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        tree.nodes[1].message.tool_calls = Some(
            (0..8)
                .map(|index| AiStoredToolCall {
                    id: format!("call-{index}"),
                    name: "tool".into(),
                    arguments: "x".repeat(251_000),
                })
                .collect(),
        );
        assert!(validate_ai_conversation(&conversation)
            .unwrap_err()
            .contains("2000000"));
    }

    #[test]
    fn interrupted_checkpoints_recover_without_claiming_success_or_losing_output() {
        let mut conversation = branch();
        let tree = conversation.tree.as_mut().unwrap();
        tree.nodes[2].message.status = "streaming".into();
        tree.nodes[2].message.actions.push(mcp("running"));
        let terminal: AiStoredAction = serde_json::from_value(json!({
            "kind": "terminal", "id": "term-1", "summary": "command", "context_source": "local:root",
            "context_label": "local", "command": "echo test", "timeout_ms": 5000, "status": "running",
            "is_remote": false, "terminal_id": "terminal-1", "output": "partial stdout", "exit_code": 0,
            "continued": true, "tool_call_id": "terminal-call", "created_at": "2026-10-10"
        })).unwrap();
        // Inactive branch must also recover, not only the selected projection.
        tree.nodes[1].message.actions.push(terminal);
        tree.nodes[1].message.actions.push(serde_json::from_value(json!({
            "kind": "edit", "id": "edit-1", "summary": "edit", "target_source": "file:one",
            "target_label": "one", "status": "applying", "edits": [{"search": "old", "replace": "new"}],
            "continued": true, "created_at": "2026-10-10"
        })).unwrap());
        let store = decode_store(&store_json(2, &conversation)).unwrap();
        let restored = &store.conversations[0];
        assert_eq!(restored.messages[1].status, "cancelled");
        match &restored.messages[1].actions[0] {
            AiStoredAction::Mcp {
                status,
                content,
                is_error,
                continued,
                tool_call_id,
                error,
                ..
            } => {
                assert_eq!(status, "error");
                assert_eq!(content.as_deref(), Some("partial tool result"));
                assert!(*is_error);
                assert!(!continued);
                assert!(error.as_ref().unwrap().contains("未知"));
                assert_eq!(tool_call_id.as_deref(), Some("call-1"));
            }
            _ => panic!("expected MCP action"),
        }
        let old = &restored.tree.as_ref().unwrap().nodes[1].message;
        match &old.actions[0] {
            AiStoredAction::Terminal {
                status,
                output,
                exit_code,
                continued,
                ..
            } => {
                assert_eq!(status, "error");
                assert_eq!(output.as_deref(), Some("partial stdout"));
                assert!(exit_code.is_none());
                assert!(!continued);
            }
            _ => panic!("expected terminal action"),
        }
        match &old.actions[1] {
            AiStoredAction::Edit {
                status,
                continued,
                edits,
                ..
            } => {
                assert_eq!(status, "error");
                assert!(!continued);
                assert_eq!(edits[0].replace, "new");
            }
            _ => panic!("expected edit action"),
        }
        // Recovery is idempotent and persistence preserves every branch.
        let twice = decode_store(&encode_store(&store).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(&twice).unwrap(),
            serde_json::to_value(&store).unwrap()
        );
    }

    #[test]
    fn checkpoint_save_keeps_inflight_states_until_load() {
        let mut conversation = conversation();
        conversation.messages[1].status = "streaming".into();
        conversation.messages[1].actions.push(mcp("running"));
        let store = AiConversationStore {
            version: 2,
            conversations: vec![conversation],
        };
        let saved = encode_store(&store).unwrap();
        let raw: AiConversationStore = serde_json::from_str(&saved).unwrap();
        assert_eq!(raw.conversations[0].messages[1].status, "streaming");
        let loaded = decode_store(&saved).unwrap();
        assert_eq!(loaded.conversations[0].messages[1].status, "cancelled");
    }

    #[test]
    fn malformed_future_and_duplicate_conversation_stores_are_rejected() {
        assert!(decode_store("{broken").is_err());
        assert!(decode_store(&store_json(3, &conversation()))
            .unwrap_err()
            .contains("版本"));
        let duplicated = json!({"version": 2, "conversations": [conversation(), conversation()]});
        assert!(decode_store(&duplicated.to_string())
            .unwrap_err()
            .contains("重复"));
    }

    #[test]
    fn merge_rechecks_limit_and_leaves_store_unchanged_on_failure() {
        let mut existing = branch();
        let tree = existing.tree.as_mut().unwrap();
        for index in 0..497 {
            let id = format!("old-{index}");
            tree.nodes.push(AiConversationNode {
                id: id.clone(),
                parent_id: Some("root".into()),
                message: message(&id),
            });
        }
        let mut store = AiConversationStore {
            version: 2,
            conversations: vec![existing],
        };
        let before = serde_json::to_value(&store).unwrap();
        let mut incoming = conversation();
        incoming.messages.push(message("one-more"));
        assert!(upsert_conversation(&mut store, incoming)
            .unwrap_err()
            .contains("500"));
        assert_eq!(serde_json::to_value(&store).unwrap(), before);
    }

    #[test]
    fn native_tool_calls_and_usage_round_trip_with_precise_schema() {
        let mut conversation = conversation();
        conversation.messages[1].tool_calls = Some(vec![AiStoredToolCall {
            id: "call-1".into(),
            name: "search".into(),
            arguments: "{\"query\":\"hello\"}".into(),
        }]);
        conversation.messages[1].usage = Some(AiStoredUsage {
            input_tokens: 12,
            output_tokens: 3,
            total_tokens: 15,
            cache_read_tokens: Some(4),
            cache_write_tokens: None,
        });
        let store = decode_store(&store_json(1, &conversation)).unwrap();
        let json: Value = serde_json::from_str(&encode_store(&store).unwrap()).unwrap();
        let message = &json["conversations"][0]["tree"]["nodes"][1]["message"];
        assert_eq!(
            message["tool_calls"][0]["arguments"],
            "{\"query\":\"hello\"}"
        );
        assert_eq!(message["usage"]["input_tokens"], 12);
        assert!(message["usage"].get("cache_write_tokens").is_none());
        assert!(json["conversations"][0]["messages"][0]
            .get("tool_calls")
            .is_none());
    }

    #[test]
    fn disk_round_trip_retains_inactive_branch() {
        let directory =
            std::env::temp_dir().join(format!("pandaterm-ai-session-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("ai-conversations.json");
        let store = AiConversationStore {
            version: 2,
            conversations: vec![branch()],
        };
        std::fs::write(&path, encode_store(&store).unwrap()).unwrap();
        let restored = decode_store(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(path_ids(&restored.conversations[0]), ["root", "new"]);
        assert_eq!(
            restored.conversations[0].tree.as_ref().unwrap().nodes.len(),
            3
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
