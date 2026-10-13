import type {
  AiConversation,
  AiToolCall,
  AiUsage,
  AiStoredAction,
  AiStoredEditAction,
  AiStoredMcpAction,
  AiStoredMessage,
  AiStoredTerminalAction,
} from './api';
import { aiTreePath, migrateAiTree, syncAiTree, type AiTree } from './aiConversationTree';
import type { AiEditProposal } from './aiEditProposal';
import type { AiMcpAction } from './aiMcpAction';
import type { AiTerminalAction } from './aiTerminalAction';

export type AiContextKind = 'terminal' | 'selection' | 'file';

export type AiContextItem = {
  kind: AiContextKind;
  label: string;
  source?: string;
  preview: string;
  isRemote?: boolean;
  terminalId?: string;
};

export type AiMessageStatus = 'complete' | 'streaming' | 'cancelled' | 'error';

export type AiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: AiToolCall[];
  toolCallId?: string;
  agentId?: string;
  accountId?: string;
  model?: string;
  stepIndex?: number;
  usage?: AiUsage;
  durationMs?: number;
  phase?: string;
  contexts: AiContextItem[];
  proposals: AiEditProposal[];
  terminalActions: AiTerminalAction[];
  mcpActions: AiMcpAction[];
  createdAt: string;
  status: AiMessageStatus;
};

export type AiConversationMode = 'ask' | 'agent';

export type AiConversationState = {
  id: string;
  title: string;
  mode: AiConversationMode;
  createdAt: string;
  updatedAt: string;
  messages: AiMessage[];
  tree?: AiTree<AiMessage>;
};

export function syncAiConversationState(conversation: AiConversationState, previous = conversation): AiConversationState {
  const sourceTree = conversation.tree !== previous.tree ? conversation.tree : previous.tree;
  const tree = syncAiTree(sourceTree ?? migrateAiTree(previous.messages), conversation.messages);
  return { ...conversation, tree };
}

/** Preserve late results on inactive branches without switching the active path. */
export function updateAiConversationMessage(
  conversation: AiConversationState,
  messageId: string,
  updater: (message: AiMessage) => AiMessage,
): AiConversationState {
  const tree = migrateAiTree(conversation.messages, conversation.tree);
  const updatedTree = { ...tree, nodes: tree.nodes.map((node) => node.id === messageId
    ? { ...node, message: updater(node.message) } : node) };
  return { ...conversation, tree: updatedTree, messages: aiTreePath(updatedTree) };
}

const INTERRUPTED_ACTION_ERROR = 'PandaTerm 在动作执行期间退出，执行结果未知。请检查目标状态后再决定是否重试。';
const INTERRUPTED_EDIT_ERROR = 'PandaTerm 在文件操作期间退出，未确认修改是否完成。请重新读取文件后审阅。';
const STALE_EDIT_REVIEW_ERROR = '文件审阅快照未持久化。请重新读取文件并生成 Diff。';

export function createAiConversationState(): AiConversationState {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    mode: 'agent',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function toStoredEditAction(proposal: AiEditProposal): AiStoredEditAction {
  return {
    kind: 'edit',
    id: proposal.id,
    summary: proposal.summary,
    target_source: proposal.targetSource,
    target_label: proposal.targetLabel,
    status: proposal.status,
    edits: proposal.edits,
    is_remote: Boolean(proposal.isRemote),
    terminal_id: proposal.terminalId ?? null,
    error: proposal.error ?? null,
    continued: Boolean(proposal.continued),
    tool_call_id: proposal.toolCallId ?? null,
    created_at: proposal.createdAt,
  };
}

function toStoredTerminalAction(action: AiTerminalAction): AiStoredTerminalAction {
  return {
    kind: 'terminal',
    id: action.id,
    summary: action.summary,
    context_source: action.contextSource,
    context_label: action.contextLabel,
    command: action.command,
    timeout_ms: action.timeoutMs,
    status: action.status,
    is_remote: action.isRemote,
    terminal_id: action.terminalId,
    output: action.output ?? null,
    exit_code: action.exitCode ?? null,
    truncated: Boolean(action.truncated),
    error: action.error ?? null,
    continued: Boolean(action.continued),
    tool_call_id: action.toolCallId ?? null,
    created_at: action.createdAt,
  };
}

function toStoredMcpAction(action: AiMcpAction): AiStoredMcpAction {
  return {
    kind: 'mcp',
    id: action.id,
    summary: action.summary,
    server_id: action.serverId,
    tool_name: action.toolName,
    arguments: action.arguments,
    status: action.status,
    content: action.content ?? null,
    is_error: Boolean(action.isError),
    error: action.error ?? null,
    continued: Boolean(action.continued),
    tool_call_id: action.toolCallId ?? null,
    created_at: action.createdAt,
  };
}

function toStoredActions(message: AiMessage): AiStoredAction[] {
  return [
    ...message.proposals.map(toStoredEditAction),
    ...message.terminalActions.map(toStoredTerminalAction),
    ...message.mcpActions.map(toStoredMcpAction),
  ];
}

function toStoredMessage(message: AiMessage): AiStoredMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    tool_calls: message.toolCalls,
    tool_call_id: message.toolCallId,
    agent_id: message.agentId,
    account_id: message.accountId,
    model: message.model,
    step_index: message.stepIndex,
    usage: message.usage,
    duration_ms: message.durationMs,
    phase: message.phase,
    contexts: message.contexts.map(({ kind, label, source }) => ({ kind, label, source: source ?? null })),
    actions: toStoredActions(message),
    created_at: message.createdAt,
    status: message.status === 'streaming' ? 'cancelled' : message.status,
  };
}

export function toStoredAiConversation(conversation: AiConversationState): AiConversation {
  const tree = migrateAiTree(conversation.messages, conversation.tree);
  // Pending assistant placeholders are not persisted; keep the latest durable ancestor active.
  const nodes = tree.nodes.filter(({ message }) => message.status !== 'streaming');
  const ids = new Set(nodes.map(({ id }) => id));
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const durableParent = (id: string | null): string | null => {
    const seen = new Set<string>();
    while (id && !ids.has(id)) {
      if (seen.has(id)) return null;
      seen.add(id);
      id = byId.get(id)?.parent_id ?? null;
    }
    return id;
  };
  const storedTree = {
    nodes: nodes.map((node) => ({ ...node, parent_id: durableParent(node.parent_id), message: toStoredMessage(node.message) })),
    active_leaf_id: durableParent(tree.active_leaf_id),
  };
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    messages: aiTreePath(storedTree),
    tree: storedTree,
  };
}

function fromStoredEditAction(action: AiStoredEditAction): AiEditProposal {
  const interrupted = action.status === 'reading' || action.status === 'applying';
  const reviewExpired = action.status === 'ready';
  return {
    id: action.id,
    summary: action.summary,
    targetSource: action.target_source,
    targetLabel: action.target_label,
    status: interrupted || reviewExpired ? 'error' : action.status,
    edits: action.edits,
    isRemote: action.is_remote,
    terminalId: action.terminal_id ?? undefined,
    error: interrupted
      ? INTERRUPTED_EDIT_ERROR
      : reviewExpired
        ? STALE_EDIT_REVIEW_ERROR
        : action.error ?? undefined,
    continued: action.continued,
    toolCallId: action.tool_call_id ?? undefined,
    createdAt: action.created_at,
  };
}

function fromStoredTerminalAction(action: AiStoredTerminalAction): AiTerminalAction {
  const interrupted = action.status === 'running';
  return {
    id: action.id,
    summary: action.summary,
    contextSource: action.context_source,
    contextLabel: action.context_label,
    command: action.command,
    timeoutMs: action.timeout_ms,
    status: interrupted ? 'error' : action.status,
    isRemote: action.is_remote,
    terminalId: action.terminal_id,
    output: action.output ?? undefined,
    exitCode: action.exit_code ?? undefined,
    truncated: action.truncated,
    error: interrupted ? INTERRUPTED_ACTION_ERROR : action.error ?? undefined,
    continued: action.continued,
    toolCallId: action.tool_call_id ?? undefined,
    createdAt: action.created_at,
  };
}

function fromStoredMcpAction(action: AiStoredMcpAction): AiMcpAction {
  const interrupted = action.status === 'running';
  return {
    id: action.id,
    summary: action.summary,
    serverId: action.server_id,
    toolName: action.tool_name,
    arguments: action.arguments,
    status: interrupted ? 'error' : action.status,
    content: action.content ?? undefined,
    isError: action.is_error,
    error: interrupted ? INTERRUPTED_ACTION_ERROR : action.error ?? undefined,
    continued: action.continued,
    toolCallId: action.tool_call_id ?? undefined,
    createdAt: action.created_at,
  };
}

function fromStoredActions(actions: AiStoredAction[] | undefined) {
  const restored = {
    proposals: [] as AiEditProposal[],
    terminalActions: [] as AiTerminalAction[],
    mcpActions: [] as AiMcpAction[],
  };
  for (const action of actions ?? []) {
    if (action.kind === 'edit') restored.proposals.push(fromStoredEditAction(action));
    if (action.kind === 'terminal') restored.terminalActions.push(fromStoredTerminalAction(action));
    if (action.kind === 'mcp') restored.mcpActions.push(fromStoredMcpAction(action));
  }
  return restored;
}

function fromStoredMessage(message: AiStoredMessage): AiMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    toolCalls: message.tool_calls,
    toolCallId: message.tool_call_id,
    agentId: message.agent_id,
    accountId: message.account_id,
    model: message.model,
    stepIndex: message.step_index,
    usage: message.usage,
    durationMs: message.duration_ms,
    phase: message.phase,
    contexts: (message.contexts ?? []).map(({ kind, label, source }) => ({ kind, label, source: source ?? undefined, preview: '' })),
    ...fromStoredActions(message.actions),
    createdAt: message.created_at,
    status: message.status,
  };
}

export function fromStoredAiConversation(conversation: AiConversation): AiConversationState {
  const storedTree = conversation.tree ?? migrateAiTree(conversation.messages);
  const tree = {
    nodes: storedTree.nodes.map((node) => ({ ...node, id: node.message.id, message: fromStoredMessage(node.message) })),
    active_leaf_id: storedTree.active_leaf_id,
  };
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode ?? 'ask',
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages: aiTreePath(tree),
    tree,
  };
}