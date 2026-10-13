import type { AiProviderConfig } from './api';
import type { AiMessage } from './aiRuntime';

export type AiRequestMetadata = {
  agentId: string;
  accountId?: string;
  model?: string;
  stepIndex?: number;
};

export type AiRequestMetadataOptions = {
  continuation: boolean;
  userMessage: Pick<AiMessage, 'agentId' | 'accountId' | 'model' | 'stepIndex'>;
  prior?: Pick<AiMessage, 'agentId' | 'accountId' | 'model' | 'stepIndex'>;
  provider: Pick<AiProviderConfig, 'account_id' | 'active_account_id' | 'model'> | null;
  newAgentId: string;
};

/**
 * Select routing metadata without allowing historical messages to pin a fresh turn.
 * Agent continuations must retain their original provider because the backend runtime
 * rejects account/model changes while pending tool work is being resumed.
 */
export function resolveAiRequestMetadata(options: AiRequestMetadataOptions): AiRequestMetadata {
  const providerAccountId = options.provider?.account_id?.trim()
    || options.provider?.active_account_id?.trim()
    || undefined;
  const providerModel = options.provider?.model?.trim() || undefined;

  if (!options.continuation) {
    return {
      agentId: options.newAgentId,
      accountId: providerAccountId,
      model: providerModel,
    };
  }

  return {
    agentId: options.userMessage.agentId ?? options.prior?.agentId ?? options.newAgentId,
    accountId: options.userMessage.accountId ?? options.prior?.accountId ?? providerAccountId,
    model: options.userMessage.model ?? options.prior?.model ?? providerModel,
    stepIndex: options.userMessage.stepIndex ?? options.prior?.stepIndex,
  };
}
