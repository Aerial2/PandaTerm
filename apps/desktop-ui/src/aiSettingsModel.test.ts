import { describe, expect, it } from 'vitest';
import {
  AI_REASONING_EFFORT_OPTIONS as CHAT_REASONING_OPTIONS,
  normalizeAiReasoningEffort as normalizeChatReasoningEffort,
} from './aiChatModel';
import {
  AI_REASONING_EFFORT_OPTIONS,
  normalizeAiReasoningEffort,
  AI_CONTEXT_WINDOW_OPTIONS,
  AI_DEFAULT_CONTEXT_WINDOW,
  MAX_AI_CONTEXT_WINDOW,
  MIN_AI_CONTEXT_WINDOW,
  normalizeAiContextWindow,
  resolveAiEffectiveContextWindow,
} from './aiSettingsModel';

describe('AI reasoning menu', () => {
  it('keeps the screenshot labels aligned with the saved reasoning values', () => {
    const expected = [
      ['Disable', 'none'], ['Low', 'low'], ['Medium', 'medium'],
      ['High', 'high'], ['X-High', 'xhigh'], ['Max', 'max'],
    ];
    for (const options of [AI_REASONING_EFFORT_OPTIONS, CHAT_REASONING_OPTIONS]) {
      expect(options.map(({ label, value }) => [label, value])).toEqual(expected);
    }
    for (const normalize of [normalizeAiReasoningEffort, normalizeChatReasoningEffort]) {
      expect(normalize('max')).toBe('max');
      expect(normalize('minimal')).toBe('minimal');
      expect(normalize('invalid')).toBe('none');
    }
  });
});

describe('AI context window presets', () => {
  it('provides the unified composer presets with automatic fallback', () => {
    expect(AI_CONTEXT_WINDOW_OPTIONS.map(({ value }) => value)).toEqual([
      200_000, 256_000, 300_000, 400_000, 500_000, 800_000, 1_000_000,
    ]);
    expect(AI_CONTEXT_WINDOW_OPTIONS.map(({ label }) => label)).toEqual([
      '200K', '256K', '300K', '400K', '500K', '800K', '1M',
    ]);
    expect(resolveAiEffectiveContextWindow(0)).toBe(AI_DEFAULT_CONTEXT_WINDOW);
    expect(resolveAiEffectiveContextWindow(null)).toBe(AI_DEFAULT_CONTEXT_WINDOW);
  });

  it('normalizes context values to the existing backend bounds', () => {
    expect(normalizeAiContextWindow(-1)).toBe(0);
    expect(normalizeAiContextWindow(MIN_AI_CONTEXT_WINDOW - 1)).toBe(MIN_AI_CONTEXT_WINDOW);
    expect(normalizeAiContextWindow(MAX_AI_CONTEXT_WINDOW + 1)).toBe(MAX_AI_CONTEXT_WINDOW);
    expect(normalizeAiContextWindow(256_400.4)).toBe(256_400);
  });
});
