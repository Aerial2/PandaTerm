import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { listLocalPortForwards, saveLocalPortForwards, startLocalPortForward, stopLocalPortForward, saveSession } from './api';
import { defaultPortForwardForm, ruleFromForm } from './portForwardModel';
beforeEach(() => vi.mocked(invoke).mockReset());
describe('port forwarding IPC', () => {
  it('uses the exact agreed command argument shapes, including the stop instance guard', async () => {
    const rule = ruleFromForm(defaultPortForwardForm(), 'rule');
    const snapshot = { terminal_id: 'terminal', generation: 'connection', revision: 1, forwards: [] };
    vi.mocked(invoke).mockResolvedValue(snapshot);
    expect(await listLocalPortForwards('terminal')).toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('list_local_port_forwards', { terminalId: 'terminal' });
    expect(await startLocalPortForward('terminal', 'rule')).toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('start_local_port_forward', { terminalId: 'terminal', ruleId: 'rule' });
    expect(await stopLocalPortForward('terminal', 'rule', 'instance')).toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith('stop_local_port_forward', { terminalId: 'terminal', ruleId: 'rule', instanceId: 'instance' });
    vi.mocked(invoke).mockResolvedValue([]);
    expect(await saveLocalPortForwards('profile', [rule])).toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith('save_local_port_forwards', { sessionId: 'profile', rules: [rule] });
  });
  it('retains saved rules in the normal connection-save payload', async () => {
    const session = { id: 'profile', name: '', group: '', host: 'host', port: 22, username: 'user', auth: { type: 'agent' as const }, tags: [], reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 }, local_port_forwards: [ruleFromForm(defaultPortForwardForm(), 'rule')] };
    await saveSession(session);
    expect(invoke).toHaveBeenCalledWith('save_session', { request: { session, secret: null, passphrase: null } });
  });
});
