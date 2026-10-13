import { describe, expect, it } from 'vitest';
import { resolveAiChatModelOptions } from './aiChatModel';

describe('resolveAiChatModelOptions', () => {
  it('exposes the complete synchronized model catalog in the chat picker', () => {
    expect(resolveAiChatModelOptions({
      model: 'gpt-5.6-sol',
      models: ['gpt-4o-mini', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5'],
      enabled_models: ['gpt-4o-mini', 'gpt-5.6-sol'],
    })).toEqual([
      'gpt-4o-mini',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-5.5',
    ]);
  });

  it('keeps the selected model when it is not yet in the catalog', () => {
    expect(resolveAiChatModelOptions({
      model: 'custom-model',
      models: ['gpt-4o-mini'],
      enabled_models: ['gpt-4o-mini'],
    })).toEqual(['custom-model', 'gpt-4o-mini']);
  });
});
