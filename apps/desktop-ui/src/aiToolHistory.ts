import type { AiChatMessage, AiToolCall } from './api';
import type { AiMessage } from './aiRuntime';

export type AiResolvedToolResult = { id: string; name: string; content: string; isError: boolean };

export function resolvedAiToolResults(message: AiMessage): AiResolvedToolResult[] {
  const results: AiResolvedToolResult[] = [];
  for (const action of message.terminalActions) {
    if (!['completed', 'timeout', 'cancelled', 'error', 'rejected'].includes(action.status)) continue;
    results.push({ id: action.toolCallId ?? action.id, name: 'run_terminal_command', content: JSON.stringify({ status: action.status, output: action.output ?? '', exit_code: action.exitCode ?? null, truncated: Boolean(action.truncated), error: action.error ?? null }), isError: action.status !== 'completed' || (action.exitCode != null && action.exitCode !== 0) });
  }
  for (const action of message.mcpActions) {
    if (!['completed', 'cancelled', 'error', 'rejected'].includes(action.status)) continue;
    results.push({ id: action.toolCallId ?? action.id, name: 'call_mcp_tool', content: JSON.stringify({ status: action.status, content: action.content ?? '', error: action.error ?? null }), isError: action.status !== 'completed' || Boolean(action.isError) });
  }
  for (const action of message.proposals) {
    if (!['applied', 'cancelled', 'error', 'stale', 'rejected'].includes(action.status)) continue;
    results.push({ id: action.toolCallId ?? action.id, name: 'propose_file_edit', content: JSON.stringify({ status: action.status, target_source: action.targetSource, summary: action.summary, error: action.error ?? null }), isError: action.status !== 'applied' });
  }
  return results;
}

export function aiMessageToolCalls(message: AiMessage): AiToolCall[] {
  const derived: AiToolCall[] = [
    ...message.terminalActions.map((action) => ({ id: action.toolCallId ?? action.id, name: 'run_terminal_command', arguments: JSON.stringify({ summary: action.summary, context_source: action.contextSource, command: action.command, timeout_ms: action.timeoutMs }) })),
    ...message.mcpActions.map((action) => ({ id: action.toolCallId ?? action.id, name: 'call_mcp_tool', arguments: JSON.stringify({ summary: action.summary, server: action.serverId, tool: action.toolName, arguments: action.arguments }) })),
    ...message.proposals.map((action) => ({ id: action.toolCallId ?? action.id, name: 'propose_file_edit', arguments: JSON.stringify({ summary: action.summary, target_source: action.targetSource, edits: action.edits }) })),
  ];
  const calls = new Map(derived.map((call) => [call.id, call]));
  for (const call of message.toolCalls ?? []) calls.set(call.id, call);
  return [...calls.values()];
}

/** Each assistant/tool group is atomic so history clipping cannot break pairing. */
export function aiToolRequestGroup(message: AiMessage, content: string): AiChatMessage[] {
  const calls = aiMessageToolCalls(message);
  const resolved = new Map(resolvedAiToolResults(message).map((result) => [result.id, result]));
  const knownIds = new Set([...message.terminalActions, ...message.mcpActions, ...message.proposals].map((action) => action.toolCallId ?? action.id));
  // Invalid/unaccepted native calls still require a paired error response.
  for (const call of calls) if (!knownIds.has(call.id)) resolved.set(call.id, { id: call.id, name: call.name, content: '工具提案未通过参数或授权上下文校验，未执行。', isError: true });
  // A new user task can supersede pending UI proposals; never send an orphaned call.
  for (const call of calls) if (!resolved.has(call.id)) resolved.set(call.id, {
    id: call.id, name: call.name, content: '工具尚未获得授权或完成，本次请求前未确认执行结果。', isError: true,
  });
  if (!calls.length) return content.trim() ? [{ role: 'assistant', content }] : [];
  return [
    { role: 'assistant', content, tool_calls: calls },
    ...calls.map((call): AiChatMessage => {
      const result = resolved.get(call.id)!;
      return { role: 'tool', tool_call_id: call.id, name: call.name, content: result.content, is_error: result.isError };
    }),
  ];
}

export function hasPendingAiTools(message: AiMessage): boolean {
  return message.terminalActions.some((action) => ['proposed', 'running'].includes(action.status))
    || message.mcpActions.some((action) => ['proposed', 'running'].includes(action.status))
    || message.proposals.some((action) => ['proposed', 'reading', 'ready', 'applying'].includes(action.status));
}