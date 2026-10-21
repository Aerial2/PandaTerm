import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PortForwardPanel } from './PortForwardPanel';
import { defaultPortForwardForm, ruleFromForm } from './portForwardModel';
const rule = ruleFromForm(defaultPortForwardForm(), 'rule');
function render(overrides: Partial<Parameters<typeof PortForwardPanel>[0]> = {}) {
  return renderToStaticMarkup(<PortForwardPanel rules={[rule]} snapshot={null} sessionName="生产服务器" canConfigure loading={false} busy={false} disabledReason={null} error={null} onRefresh={vi.fn()} onSave={vi.fn()} onStart={vi.fn()} onStop={vi.fn()} {...overrides} />);
}
describe('PortForwardPanel', () => {
  it('shows saved endpoint addresses and stopped manual-start behavior', () => {
    const html = render();
    expect(html).toContain('生产服务器'); expect(html).toContain('127.0.0.1:8080'); expect(html).toContain('127.0.0.1:80');
    expect(html).toContain('已停止'); expect(html).toContain('启动'); expect(html).toContain('复制本地地址');
    expect(html).toContain('重连后需再次启动'); expect(html).toContain('远程服务是否可达');
  });
  it('disables start and explains an unconnected SSH while allowing profile configuration', () => {
    const html = render({ disabledReason: 'SSH 尚未连接' });
    expect(html).toContain('SSH 尚未连接');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?启动<\/button>/);
    expect(html).toMatch(/<button type="button" title="新增规则">/);
  });
  it('shows active and failed states, backend errors, and nonloopback exposure', () => {
    const forward = { rule_id: 'rule', instance_id: 'instance', state: 'listening' as const, local_host: '0.0.0.0', local_port: 18685, remote_host: '127.0.0.1', remote_port: 18685, last_error: 'remote target refused' };
    const html = render({ rules: [{ ...rule, local_host: '0.0.0.0' }], snapshot: { terminal_id: 't', generation: 'g', revision: 1, forwards: [forward] } });
    expect(html).toContain('正在监听'); expect(html).toContain('停止'); expect(html).toContain('remote target refused'); expect(html).toContain('其他设备访问');
    expect(render({ snapshot: { terminal_id: 't', generation: 'g', revision: 2, forwards: [{ ...forward, state: 'failed' }] } })).toContain('失败');
  });
  it.each(['listening', 'failed'] as const)('keeps runtime-only %s instances visible and stoppable after another pane deletes the rule', (state) => {
    const html = render({ rules: [], snapshot: { terminal_id: 'pane-b', generation: 'g', revision: 2, forwards: [{ rule_id: 'removed-rule', instance_id: 'still-running', state, local_host: '::1', local_port: 28685, remote_host: 'db.internal', remote_port: 5432 }] } });
    expect(html).toContain('未保存的隧道'); expect(html).toContain('规则已从保存配置中删除');
    expect(html).toContain('[::1]:28685'); expect(html).toContain('db.internal:5432');
    expect(html).not.toContain('暂无转发规则');
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.find((button) => button.includes('复制本地地址'))).not.toContain('disabled');
    expect(buttons.find((button) => button.endsWith('停止</button>'))).not.toContain('disabled');
    expect(buttons.find((button) => button.endsWith('编辑</button>'))).toContain('disabled');
    expect(buttons.find((button) => button.includes('删除规则'))).toContain('disabled');
    expect(buttons.some((button) => button.endsWith('启动</button>'))).toBe(false);
  });
  it('renders empty and unsupported reasons and exposes errors as alerts', () => {
    const html = render({ rules: [], canConfigure: false, disabledReason: 'RDP 连接不支持 SSH 隧道', error: '无法读取' });
    expect(html).toContain('暂无转发规则'); expect(html).toContain('RDP 连接不支持'); expect(html).toContain('role="alert"');
  });
});
