import type { AiMessage } from './aiRuntime';

export function formatAiDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

export function formatAiTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tokens`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

export function aiOutputTokenRate(message: Pick<AiMessage, 'durationMs' | 'usage'>): string | undefined {
  if (!message.usage || !message.durationMs || !Number.isFinite(message.durationMs) || message.durationMs < 0) return undefined;
  return `${Math.round(message.usage.output_tokens * 1000 / message.durationMs)} token/s`;
}

export function aiMessagePhaseLabel(message: Pick<AiMessage, 'phase' | 'status' | 'durationMs'>): string | undefined {
  if (message.status === 'complete' || message.phase === 'completed') {
    const duration = formatAiDuration(message.durationMs);
    return duration ? `已处理 ${duration}` : '已处理';
  }
  if (message.status !== 'streaming') return undefined;
  return message.phase;
}
