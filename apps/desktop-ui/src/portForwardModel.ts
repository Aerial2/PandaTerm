import type { LocalPortForward, PortForwardSnapshot } from './api';
import type { WorkspaceTab } from './terminalLayout';

export type PortForwardForm = { name: string; local_host: string; local_port: string; remote_host: string; remote_port: string };

export function defaultPortForwardForm(): PortForwardForm {
  return { name: '隧道名称', local_host: '127.0.0.1', local_port: '8080', remote_host: '127.0.0.1', remote_port: '80' };
}

export function portForwardForm(rule: LocalPortForward): PortForwardForm {
  return { ...rule, local_port: String(rule.local_port), remote_port: String(rule.remote_port) };
}

function isIPv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((part) => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
}

export function isIpAddress(host: string): boolean {
  if (isIPv4(host)) return true;
  if (!host.includes(':') || /[^\da-fA-F:.]/.test(host)) return false;
  let value = host;
  if (value.includes('.')) {
    const suffix = value.slice(value.lastIndexOf(':') + 1);
    if (!isIPv4(suffix)) return false;
    value = value.slice(0, value.lastIndexOf(':') + 1) + '0:0';
  }
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const parts = halves.flatMap((half) => half ? half.split(':') : []);
  if (!parts.every((part) => /^[\da-fA-F]{1,4}$/.test(part))) return false;
  return halves.length === 2 ? parts.length < 8 : parts.length === 8;
}

export function isLoopback(host: string): boolean {
  if (isIPv4(host)) return host.split('.')[0] === '127';
  if (!isIpAddress(host)) return false;
  // Expand compressed IPv6 so all spellings of ::1 are treated alike.
  const halves = host.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return parts.length === 8 && parts.slice(0, 7).every((part) => parseInt(part, 16) === 0) && parseInt(parts[7], 16) === 1;
}

export function validatePortForwardForm(form: PortForwardForm): string | null {
  if (!form.name.trim()) return '请输入规则名称';
  if (!isIpAddress(form.local_host.trim())) return '本地监听地址必须是 IPv4 或 IPv6 地址';
  for (const [label, value] of [['本地端口号', form.local_port], ['远程端口号', form.remote_port]]) {
    if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 65535) return `${label}必须是 1–65535 的整数`;
  }
  const remote = form.remote_host.trim();
  const dns = remote.replace(/\.$/, '');
  if (!isIpAddress(remote) && !(dns.length <= 253 && dns.split('.').every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part)) && !/^[\d.]+$/.test(remote))) {
    return '远程目标地址必须是 IP 地址或 DNS 名称';
  }
  return null;
}

export function ruleFromForm(form: PortForwardForm, id: string): LocalPortForward {
  return { id, name: form.name.trim(), local_host: form.local_host.trim(), local_port: Number(form.local_port), remote_host: form.remote_host.trim(), remote_port: Number(form.remote_port) };
}

export function localAddress(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function portForwardDisabledReason(tab: WorkspaceTab | null): string | null {
  if (!tab) return '请选择已连接的 SSH 终端';
  if (tab.session.id === 'local-system') return '本地终端不支持 SSH 隧道';
  if (tab.kind === 'rdp' || tab.session.protocol === 'rdp') return 'RDP 连接不支持 SSH 隧道';
  if (tab.kind !== 'terminal' || (tab.session.protocol && tab.session.protocol !== 'ssh')) return '请选择 SSH 终端';
  if (tab.status !== 'connected' || !tab.terminalId) return 'SSH 尚未连接，连接后可手动启用隧道';
  return null;
}

export function acceptsSnapshot(current: PortForwardSnapshot | null, next: PortForwardSnapshot, terminalId: string, authoritative: boolean): boolean {
  if (next.terminal_id !== terminalId) return false;
  if (!current) return authoritative;
  if (next.generation !== current.generation) return authoritative;
  return next.revision >= current.revision;
}
