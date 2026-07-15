import type {
  AiConversation,
  AiStoredAction,
  AiStoredEditAction,
  AiStoredMcpAction,
  AiStoredMessage,
  AiStoredTerminalAction,
} from './api';
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
  role: 'user' | 'assistant';
  content: string;
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
};

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

export function toStoredAiConversation(conversation: AiConversationState): AiConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    messages: conversation.messages.flatMap<AiStoredMessage>((message) => {
      if (message.status === 'streaming') return [];
      return [{
        id: message.id,
        role: message.role,
        content: message.content,
        contexts: message.contexts.map(({ kind, label, source }) => ({ kind, label, source: source ?? null })),
        actions: toStoredActions(message),
        created_at: message.createdAt,
        status: message.status,
      }];
    }),
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

export function fromStoredAiConversation(conversation: AiConversation): AiConversationState {
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode ?? 'ask',
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      contexts: message.contexts.map(({ kind, label, source }) => ({
        kind,
        label,
        source: source ?? undefined,
        preview: '',
      })),
      ...fromStoredActions(message.actions),
      createdAt: message.created_at,
      status: message.status,
    })),
  };
}