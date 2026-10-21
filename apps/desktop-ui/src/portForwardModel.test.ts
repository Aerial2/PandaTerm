import { describe, expect, it } from 'vitest';
import { acceptsSnapshot, defaultPortForwardForm, isIpAddress, isLoopback, localAddress, portForwardDisabledReason, ruleFromForm, validatePortForwardForm } from './portForwardModel';
import type { WorkspaceTab } from './terminalLayout';

const tab: WorkspaceTab = { id: 'pane', kind: 'terminal', terminalId: 'terminal', status: 'connected', title: '', output: [], closedByUser: false, reconnectAttempts: 0, activityLog: [], session: { id: 'ssh', name: '', host: 'host', port: 22, username: 'user', group: '', auth: { type: 'agent' }, tags: [], reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 } } };
describe('port forward model', () => {
  it('uses generic tunnel defaults and trims persisted fields', () => {
    const form = defaultPortForwardForm();
    expect(validatePortForwardForm(form)).toBeNull();
    expect(ruleFromForm({ ...form, name: ' 隧道名称 ', remote_host: ' server.example ' }, 'id')).toEqual({ id: 'id', name: '隧道名称', local_host: '127.0.0.1', local_port: 8080, remote_host: 'server.example', remote_port: 80 });
  });
  it.each(['0', '65536', '1.5', '1e3', '-1', '', 'NaN', '0x50'])('rejects invalid port %s on either side', (value) => {
    for (const key of ['local_port', 'remote_port']) expect(validatePortForwardForm({ ...defaultPortForwardForm(), [key]: value })).toContain('整数');
  });
  it.each(['127.0.0.1', '0.0.0.0', '::', '::1', '2001:db8::1', '2001:db8:0:1:2:3:4:5', '::ffff:192.0.2.1'])('accepts local IP %s', (local_host) => {
    expect(isIpAddress(local_host)).toBe(true);
    expect(validatePortForwardForm({ ...defaultPortForwardForm(), local_host })).toBeNull();
  });
  it.each(['localhost', '256.1.1.1', '01.2.3.4', '[::1]', '1:2:3', '1::2::3', '1:2:3:4:5:6:7:8:9', '::ffff:999.1.1.1'])('rejects local IP %s', (local_host) => {
    expect(validatePortForwardForm({ ...defaultPortForwardForm(), local_host })).toContain('IPv4');
  });
  it.each(['localhost', 'db.internal', 'server-1.example.', '2001:db8::1'])('accepts remote DNS/IP %s', (remote_host) => expect(validatePortForwardForm({ ...defaultPortForwardForm(), remote_host })).toBeNull());
  it.each(['', 'https://host', 'host:8080', '-host', 'host..com', '999.1.1.1', 'a'.repeat(64) + '.com'])('rejects invalid remote %s', (remote_host) => expect(validatePortForwardForm({ ...defaultPortForwardForm(), remote_host })).toContain('DNS'));
  it('recognizes IPv4 and expanded IPv6 loopback and formats IPv6 copy addresses', () => {
    expect(isLoopback('127.20.1.1')).toBe(true);
    expect(isLoopback('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::')).toBe(false);
    expect(isLoopback('192.168.1.2')).toBe(false);
    expect(localAddress('::1', 18685)).toBe('[::1]:18685');
  });
  it('explains unsupported and disconnected targets without rejecting backward compatible SSH profiles', () => {
    expect(portForwardDisabledReason(tab)).toBeNull();
    expect(portForwardDisabledReason(null)).toContain('请选择');
    expect(portForwardDisabledReason({ ...tab, session: { ...tab.session, id: 'local-system' } })).toContain('本地');
    expect(portForwardDisabledReason({ ...tab, kind: 'rdp' })).toContain('RDP');
    expect(portForwardDisabledReason({ ...tab, status: 'reconnecting' })).toContain('尚未连接');
  });
  it('requires authoritative list for generation replacement and rejects old revisions/other terminals', () => {
    const current = { terminal_id: 't', generation: 'g', revision: 5, forwards: [] };
    expect(acceptsSnapshot(current, { ...current, revision: 4 }, 't', true)).toBe(false);
    expect(acceptsSnapshot(current, { ...current, generation: 'new' }, 't', false)).toBe(false);
    expect(acceptsSnapshot(current, { ...current, generation: 'new' }, 't', true)).toBe(true);
    expect(acceptsSnapshot(current, { ...current, terminal_id: 'other' }, 't', true)).toBe(false);
  });
});
