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

export function applyTerminalLifecycleState(
  current: TerminalRuntimeStatus,
  next: TerminalLifecycleState,
): TerminalRuntimeStatus {
  if (current === 'closed') return current;

  if (next === 'connected') {
    return current === 'failed' ? current : 'connected';
  }
  if (next === 'failed') return 'failed';
  return current === 'failed' ? current : 'disconnected';
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