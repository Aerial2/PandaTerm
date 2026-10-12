import type { AiChatStreamEvent, AiToolCall, AiUsage } from './api';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export function parseAiStreamEvent(value: unknown): AiChatStreamEvent | null {
  const raw = object(value);
  if (!raw || !text(raw.request_id) || !['started', 'delta', 'usage', 'phase', 'tool_result', 'completed', 'cancelled', 'error'].includes(String(raw.kind))) return null;
  if (raw.protocol != null && raw.protocol !== 'pandaterm.ai.v1') return null;
  const usage = object(raw.usage);
  let normalizedUsage: AiUsage | undefined;
  if (usage && count(usage.input_tokens) !== undefined && count(usage.output_tokens) !== undefined) {
    normalizedUsage = {
      input_tokens: count(usage.input_tokens)!, output_tokens: count(usage.output_tokens)!,
      total_tokens: count(usage.total_tokens) ?? count(usage.input_tokens)! + count(usage.output_tokens)!,
      cache_read_tokens: count(usage.cache_read_tokens), cache_write_tokens: count(usage.cache_write_tokens),
    };
  }
  const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls.flatMap<AiToolCall>((entry) => {
    const call = object(entry);
    if (!call || !text(call.id)) return [];
    const fn = object(call.function) ?? call;
    if (!text(fn.name)) return [];
    return [{ id: String(call.id), name: String(fn.name), arguments: text(fn.arguments) ?? JSON.stringify(fn.arguments ?? {}) }];
  }) : undefined;
  const result = object(raw.tool_result);
  const toolResult = result && text(result.tool_call_id) && text(result.name) && text(result.status)
    && typeof result.content === 'string' && typeof result.is_error === 'boolean'
    ? { tool_call_id: String(result.tool_call_id), name: String(result.name), status: String(result.status), content: result.content, is_error: result.is_error }
    : undefined;
  return {
    request_id: String(raw.request_id), kind: raw.kind as AiChatStreamEvent['kind'], protocol: text(raw.protocol),
    agent_id: text(raw.agent_id), step_id: text(raw.step_id), step_index: count(raw.step_index), sequence: count(raw.sequence),
    delta: text(raw.delta), model: text(raw.model), message: text(raw.message), phase: text(raw.phase),
    usage: normalizedUsage, tool_calls: toolCalls,
    tool_result: toolResult,
  };
}

export type AiStreamCursor = {
  requestId: string;
  agentId?: string;
  stepIndex?: number;
  stepId?: string;
  sequence?: number;
  finished?: boolean;
};

/** Legacy unsequenced events remain accepted, but cannot bypass an identified newer step. */
export function acceptAiStreamEvent(cursor: AiStreamCursor, event: AiChatStreamEvent): boolean {
  if (cursor.finished || event.request_id !== cursor.requestId || (event.agent_id && cursor.agentId && event.agent_id !== cursor.agentId)) return false;
  if (event.step_index != null && cursor.stepIndex != null && event.step_index < cursor.stepIndex) return false;
  if (event.step_id && cursor.stepId && event.step_id !== cursor.stepId && !(event.step_index != null && (cursor.stepIndex == null || event.step_index > cursor.stepIndex))) return false;
  const newStep = event.step_index != null && (cursor.stepIndex == null || event.step_index > cursor.stepIndex);
  if (!newStep && event.sequence != null && cursor.sequence != null && event.sequence <= cursor.sequence) return false;
  if (newStep) {
    cursor.sequence = undefined;
    cursor.stepId = undefined;
  }
  if (event.step_index != null) cursor.stepIndex = event.step_index;
  if (event.step_id) cursor.stepId = event.step_id;
  if (event.sequence != null) cursor.sequence = event.sequence;
  if (['completed', 'cancelled', 'error'].includes(event.kind)) cursor.finished = true;
  return true;
}