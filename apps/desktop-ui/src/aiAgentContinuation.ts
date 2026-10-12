import { canContinueAiAgent, isAiAgentContinuationMessage } from './aiChatModel';
import type { AiConversationState, AiMessage } from './aiRuntime';
import { aiMessageToolCalls, aiToolRequestGroup, hasPendingAiTools } from './aiToolHistory';

/** Build one continuation only after every proposal in this turn has resolved. */
export function prepareAiToolContinuation(
  conversation: AiConversationState,
  messageId: string,
  newId: () => string = () => crypto.randomUUID(),
): { baseMessages: AiMessage[]; resultMessage: AiMessage } | null {
  if (conversation.mode !== 'agent' || !canContinueAiAgent(conversation)) return null;
  const sourceIndex = conversation.messages.findIndex((message) => message.id === messageId);
  const source = conversation.messages[sourceIndex];
  if (!source || source.status !== 'complete' || hasPendingAiTools(source)) return null;
  const lastTaskIndex = conversation.messages.map((message, index) => ({ message, index }))
    .reverse().find(({ message }) => message.role === 'user' && !isAiAgentContinuationMessage(message))?.index ?? -1;
  const lastTask = conversation.messages[lastTaskIndex];
  if (lastTaskIndex > sourceIndex || (source.agentId && lastTask?.agentId && source.agentId !== lastTask.agentId)) return null;
  const calls = aiMessageToolCalls(source);
  const actions = [...source.terminalActions, ...source.mcpActions, ...source.proposals];
  if (!calls.length || (actions.length > 0 && actions.every((action) => action.continued))) return null;
  if (conversation.messages.slice(sourceIndex + 1).some((message) => message.role === 'tool' && message.toolCallId === calls[0].id)) return null;
  const baseMessages = conversation.messages.map((message) => message.id === messageId ? {
    ...message,
    terminalActions: message.terminalActions.map((action) => ({ ...action, continued: true })),
    mcpActions: message.mcpActions.map((action) => ({ ...action, continued: true })),
    proposals: message.proposals.map((action) => ({ ...action, continued: true })),
  } : message);
  const resultMessage: AiMessage = {
    id: newId(), role: 'tool', toolCallId: calls[0].id,
    content: JSON.stringify(aiToolRequestGroup(source, '').filter((message) => message.role === 'tool')),
    agentId: source.agentId, accountId: lastTask?.accountId ?? source.accountId, model: lastTask?.model ?? source.model,
    stepIndex: source.stepIndex, contexts: lastTask?.contexts ?? [], proposals: [], terminalActions: [], mcpActions: [],
    createdAt: new Date().toISOString(), status: 'complete',
  };
  return { baseMessages, resultMessage };
}