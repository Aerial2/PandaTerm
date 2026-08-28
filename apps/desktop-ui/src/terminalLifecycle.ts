import type { TerminalStatusEvent } from './api';

export type TerminalLifecycleState = TerminalStatusEvent['state'];
export type TerminalTransport = TerminalStatusEvent['transport'];

export type { TerminalStatusEvent };

export type TerminalRuntimeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disconnected'
  | 'closed';

export type ReconnectPolicy = {
  enabled: boolean;
  max_attempts: number;
  delay_ms: number;
};

export function shouldReconnect(
  current: TerminalRuntimeStatus,
  policy: ReconnectPolicy,
  manuallyClosed: boolean,
  attempt: number,
): boolean {
  return !manuallyClosed
    && policy.enabled
    && current !== 'closed'
    && attempt < Math.max(0, policy.max_attempts);
}

export function reconnectDelayMs(policy: ReconnectPolicy, attempt: number): number {
  const base = Math.max(0, policy.delay_ms);
  const exponent = Math.max(0, Math.min(attempt, 6));
  return Math.min(base * (2 ** exponent), 60_000);
}

export function applyTerminalLifecycleState(
  current: TerminalRuntimeStatus,
  next: TerminalLifecycleState,
): TerminalRuntimeStatus {
  if (current === 'closed') return current;

  if (next === 'connected') return current === 'failed' ? current : 'connected';
  if (next === 'failed') return 'failed';
  return current === 'failed' ? 'failed' : 'disconnected';
}

export function shouldApplyTerminalStatus(
  event: TerminalStatusEvent,
  retiredTerminalIds: ReadonlySet<string>,
): boolean {
  return !retiredTerminalIds.has(event.terminal_id);
}

export function terminalLifecycleMessage(event: TerminalStatusEvent): string {
  if (event.reason) return event.reason;
  if (event.state === 'connected') return '已连接';
  if (event.state === 'failed') return '连接失败';
  return '已断开';
}