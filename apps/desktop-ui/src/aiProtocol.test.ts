import { describe, expect, it } from 'vitest';
import { acceptAiStreamEvent, parseAiStreamEvent, type AiStreamCursor } from './aiProtocol';
import type { AiChatStreamEvent } from './api';

const event = (fields: Partial<AiChatStreamEvent> = {}): AiChatStreamEvent => ({ request_id: 'r', kind: 'delta', delta: 'text', ...fields });

describe('AI stream protocol compatibility', () => {
  it('accepts legacy events and all supported kinds', () => {
    for (const kind of ['started', 'delta', 'usage', 'phase', 'tool_result', 'completed', 'cancelled', 'error']) {
      expect(parseAiStreamEvent({ request_id: 'r', kind })?.kind).toBe(kind);
    }
    expect(parseAiStreamEvent(event())?.delta).toBe('text');
  });

  it('normalizes usage and flat/OpenAI-style tool calls', () => {
    expect(parseAiStreamEvent({ ...event(), protocol: 'pandaterm.ai.v1', usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 2 }, tool_calls: [
      { id: 'a', name: 'tool', arguments: '{}' },
      { id: 'b', function: { name: 'edit', arguments: { summary: 'x' } } },
    ] })).toMatchObject({ usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, cache_read_tokens: 2 }, tool_calls: [
      { id: 'a', name: 'tool', arguments: '{}' }, { id: 'b', name: 'edit', arguments: '{"summary":"x"}' },
    ] });
  });

  it('rejects unknown protocols and malformed payloads without throwing', () => {
    for (const value of [null, [], 'event', {}, { kind: 'delta' }, event({ protocol: 'unknown' }), { request_id: 'r', kind: 'unknown' }]) {
      expect(parseAiStreamEvent(value)).toBeNull();
    }
    expect(parseAiStreamEvent({ ...event(), usage: { input_tokens: -1, output_tokens: 3 }, tool_calls: [null, {}] })).toMatchObject({ usage: undefined, tool_calls: [] });
  });

  it('normalizes unified tool results', () => {
    const result = { tool_call_id: 'c', name: 'tool', status: 'completed', content: 'ok', is_error: false };
    expect(parseAiStreamEvent({ ...event({ kind: 'tool_result' }), tool_result: result })?.tool_result).toEqual(result);
    expect(parseAiStreamEvent({ ...event({ kind: 'tool_result' }), tool_result: { ...result, is_error: 'false' } })?.tool_result).toBeUndefined();
  });

  it('filters foreign requests/agents, duplicates, stale steps and finished requests', () => {
    const cursor: AiStreamCursor = { requestId: 'r', agentId: 'a' };
    expect(acceptAiStreamEvent(cursor, event({ request_id: 'other' }))).toBe(false);
    expect(acceptAiStreamEvent(cursor, event({ agent_id: 'other' }))).toBe(false);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 0, step_id: 's0', sequence: 1 }))).toBe(true);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 0, sequence: 1 }))).toBe(false);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 1, step_id: 's1', sequence: 0 }))).toBe(true);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 0, step_id: 's0', sequence: 99 }))).toBe(false);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 1, step_id: 's0', sequence: 99 }))).toBe(false);
    expect(acceptAiStreamEvent(cursor, event({ kind: 'completed', sequence: 1 }))).toBe(true);
    expect(acceptAiStreamEvent(cursor, event({ sequence: 2 }))).toBe(false);
  });

  it('clears the old step ID when a newer step initially omits it', () => {
    const cursor: AiStreamCursor = { requestId: 'r', stepIndex: 0, stepId: 'old', sequence: 5 };
    expect(acceptAiStreamEvent(cursor, event({ step_index: 1, sequence: 0 }))).toBe(true);
    expect(acceptAiStreamEvent(cursor, event({ step_index: 1, step_id: 'new', sequence: 1 }))).toBe(true);
  });

  it('continues accepting unsequenced legacy events', () => {
    const cursor: AiStreamCursor = { requestId: 'r' };
    expect(acceptAiStreamEvent(cursor, event())).toBe(true);
    expect(acceptAiStreamEvent(cursor, event())).toBe(true);
    expect(acceptAiStreamEvent(cursor, event({ kind: 'cancelled' }))).toBe(true);
    expect(acceptAiStreamEvent(cursor, event())).toBe(false);
  });
});