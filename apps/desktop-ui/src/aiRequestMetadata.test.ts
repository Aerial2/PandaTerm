import { describe, expect, it } from 'vitest';
import { resolveAiRequestMetadata } from './aiRequestMetadata';

const provider = { account_id: 'new-account', active_account_id: 'new-account', model: 'new-model' };

const pinned = {
  agentId: 'old-agent',
  accountId: 'old-account',
  model: 'old-model',
  stepIndex: 2,
};

describe('AI request metadata routing', () => {
  it('uses the refreshed provider for a new turn in an existing conversation', () => {
    expect(resolveAiRequestMetadata({
      continuation: false,
      userMessage: pinned,
      prior: pinned,
      provider,
      newAgentId: 'new-agent',
    })).toEqual({
      agentId: 'new-agent',
      accountId: 'new-account',
      model: 'new-model',
    });
  });

  it('keeps the original provider pinned for a continuation', () => {
    expect(resolveAiRequestMetadata({
      continuation: true,
      userMessage: { agentId: 'continuation-agent', accountId: 'old-account', model: 'old-model', stepIndex: 3 },
      prior: pinned,
      provider,
      newAgentId: 'unused-agent',
    })).toEqual({
      agentId: 'continuation-agent',
      accountId: 'old-account',
      model: 'old-model',
      stepIndex: 3,
    });
  });

  it('falls back to the prior runtime when a continuation message is partial', () => {
    expect(resolveAiRequestMetadata({
      continuation: true,
      userMessage: { agentId: undefined, accountId: undefined, model: undefined, stepIndex: undefined },
      prior: pinned,
      provider,
      newAgentId: 'unused-agent',
    })).toEqual(pinned);
  });
});
