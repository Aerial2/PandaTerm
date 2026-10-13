import { describe, expect, it } from 'vitest';
import { aiMessagePhaseLabel, aiOutputTokenRate, formatAiDuration, formatAiTokens } from './aiMessageStats';

describe('AI message statistics', () => {
  it('formats elapsed time across minute boundaries', () => {
    expect(formatAiDuration(125_999)).toBe('2分5秒');
    expect(formatAiDuration(59_999)).toBe('0分59秒');
    expect(formatAiDuration(60_000)).toBe('1分0秒');
    expect(formatAiDuration(0)).toBe('0分0秒');
  });

  it('does not invent elapsed time or throughput for legacy messages', () => {
    expect(formatAiDuration(undefined)).toBeUndefined();
    expect(formatAiDuration(NaN)).toBeUndefined();
    expect(formatAiDuration(-1)).toBeUndefined();
    expect(aiOutputTokenRate({ durationMs: 0, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })).toBeUndefined();
    expect(aiOutputTokenRate({})).toBeUndefined();
    expect(aiMessagePhaseLabel({ status: 'complete', phase: 'completed' })).toBe('已处理');
  });

  it('uses output tokens for speed and total tokens for the compact total', () => {
    expect(aiOutputTokenRate({ durationMs: 125_000, usage: { input_tokens: 273375, output_tokens: 7625, total_tokens: 281000 } })).toBe('61 token/s');
    expect(formatAiTokens(281000)).toBe('281.0k tokens');
    expect(formatAiTokens(999)).toBe('999 tokens');
    expect(formatAiTokens(1500000)).toBe('1.5m tokens');
  });

  it('replaces completed and stops showing stale thinking phases', () => {
    expect(aiMessagePhaseLabel({ status: 'complete', phase: 'completed', durationMs: 125000 })).toBe('已处理 2分5秒');
    expect(aiMessagePhaseLabel({ status: 'complete', phase: 'thinking', durationMs: 125000 })).toBe('已处理 2分5秒');
    expect(aiMessagePhaseLabel({ status: 'cancelled', phase: 'thinking' })).toBeUndefined();
    expect(aiMessagePhaseLabel({ status: 'streaming', phase: 'thinking' })).toBe('thinking');
  });
});
