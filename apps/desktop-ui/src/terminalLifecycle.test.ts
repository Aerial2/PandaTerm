import { describe, expect, it } from 'vitest';
import {
  applyTerminalLifecycleState,
  shouldApplyTerminalStatus,
  terminalLifecycleMessage,
  type TerminalStatusEvent,
} from './terminalLifecycle';

describe('applyTerminalLifecycleState', () => {
  it('connects terminals from startup states', () => {
    expect(applyTerminalLifecycleState('connecting', 'connected')).toBe('connected');
    expect(applyTerminalLifecycleState('reconnecting', 'connected')).toBe('connected');
  });

  it('preserves failure against late connected or disconnected events', () => {
    expect(applyTerminalLifecycleState('failed', 'connected')).toBe('failed');
    expect(applyTerminalLifecycleState('failed', 'disconnected')).toBe('failed');
  });

  it('does not revive a closed terminal', () => {
    expect(applyTerminalLifecycleState('closed', 'connected')).toBe('closed');
    expect(applyTerminalLifecycleState('closed', 'failed')).toBe('closed');
  });

  it('moves connected terminals to disconnected', () => {
    expect(applyTerminalLifecycleState('connected', 'disconnected')).toBe('disconnected');
  });
});

describe('shouldApplyTerminalStatus', () => {
  const event: TerminalStatusEvent = {
    terminal_id: 'terminal-1',
    transport: 'remote',
    state: 'disconnected',
  };

  it('accepts lifecycle events for active terminals', () => {
    expect(shouldApplyTerminalStatus(event, new Set())).toBe(true);
  });

  it('filters late lifecycle events for retired terminals', () => {
    expect(shouldApplyTerminalStatus(event, new Set(['terminal-1']))).toBe(false);
  });
});

describe('terminalLifecycleMessage', () => {
  it('prefers the backend reason', () => {
    const event: TerminalStatusEvent = {
      terminal_id: 'terminal-1',
      transport: 'remote',
      state: 'failed',
      reason: 'SSH channel closed',
    };
    expect(terminalLifecycleMessage(event)).toBe('SSH channel closed');
  });

  it('uses stable fallback messages', () => {
    expect(terminalLifecycleMessage({ terminal_id: '1', transport: 'local', state: 'connected' })).toBe('已连接');
    expect(terminalLifecycleMessage({ terminal_id: '1', transport: 'local', state: 'failed' })).toBe('连接失败');
    expect(terminalLifecycleMessage({ terminal_id: '1', transport: 'local', state: 'disconnected' })).toBe('已断开');
  });
});