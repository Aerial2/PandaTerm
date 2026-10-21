import { useState } from 'react';
import { Copy, Play, Plus, Square, Trash2, Pencil, Save, X, RefreshCw } from 'lucide-react';
import { writeClipboardText, type LocalPortForward, type PortForwardSnapshot } from './api';
import type { PortForwardForm } from './portForwardModel';
import { defaultPortForwardForm, isIpAddress, isLoopback, localAddress, portForwardForm, ruleFromForm, validatePortForwardForm } from './portForwardModel';
import './PortForwardPanel.css';

type Props = {
  rules: LocalPortForward[];
  snapshot: PortForwardSnapshot | null;
  sessionName: string | null;
  canConfigure: boolean;
  disabledReason: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onRefresh: () => Promise<unknown>;
  onSave: (rules: LocalPortForward[], changedRuleId?: string, startRuleId?: string) => Promise<unknown>;
  onStart: (ruleId: string) => Promise<unknown>;
  onStop: (ruleId: string, instanceId: string) => Promise<unknown>;
};

export function PortForwardPanel({ rules, snapshot, sessionName, canConfigure, disabledReason, loading, busy, error, onRefresh, onSave, onStart, onStop }: Props) {
  const [editing, setEditing] = useState<{ id: string; form: PortForwardForm } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const statuses = snapshot?.forwards ?? [];
  const displayedRules: LocalPortForward[] = [...rules, ...statuses
    .filter((status) => !rules.some((rule) => rule.id === status.rule_id))
    .map((status) => ({ id: status.rule_id, name: '未保存的隧道', local_host: status.local_host, local_port: status.local_port, remote_host: status.remote_host, remote_port: status.remote_port }))];
  const pending = busy || working;
  const unavailable = Boolean(disabledReason) || pending || loading;
  const beginAdd = () => { setEditing({ id: crypto.randomUUID(), form: defaultPortForwardForm() }); setFormError(null); };
  const update = (key: keyof PortForwardForm, value: string) => setEditing((valueBefore) => valueBefore && { ...valueBefore, form: { ...valueBefore.form, [key]: value } });
  async function run(action: () => Promise<unknown>) {
    setWorking(true); setFormError(null);
    try { await action(); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  }
  async function persist(startAfter: boolean) {
    if (!editing) return;
    const validation = validatePortForwardForm(editing.form);
    if (validation) { setFormError(validation); return; }
    const rule = ruleFromForm(editing.form, editing.id);
    const exists = rules.some((item) => item.id === editing.id);
    await run(async () => {
      await onSave(exists ? rules.map((item) => item.id === rule.id ? rule : item) : [...rules, rule], exists ? rule.id : undefined, startAfter ? rule.id : undefined);
      setEditing(null);
    });
  }
  return <aside className="port-forward-panel" aria-label="SSH 隧道">
    <header className="port-forward-header"><div><h2>SSH 隧道</h2><span>{sessionName ?? '本地端口转发'}</span></div><div className="port-forward-actions"><button type="button" onClick={() => void run(onRefresh)} disabled={unavailable} title="刷新隧道状态" aria-label="刷新隧道状态"><RefreshCw size={15} /></button><button type="button" onClick={beginAdd} disabled={!canConfigure || pending} title={canConfigure ? '新增规则' : disabledReason ?? undefined}><Plus size={16} />新增</button></div></header>
    <p className="port-forward-help">规则手动启用；断开后停止，重连后需再次启动。监听成功仅表示本地端口已就绪，远程服务是否可达需实际访问确认。</p>
    {disabledReason && <div className="port-forward-notice" role="status">{disabledReason}</div>}
    {(formError || error) && <div className="port-forward-error" role="alert">{formError || error}</div>}
    {loading && <div className="port-forward-loading" role="status">正在读取隧道状态...</div>}
    {rules.length === 0 && statuses.length === 0 && <div className="port-forward-empty">暂无转发规则<button type="button" onClick={beginAdd} disabled={!canConfigure || pending}><Plus size={15} />添加第一条规则</button></div>}
    <div className="port-forward-list">{displayedRules.map((rule) => {
      const status = statuses.find((item) => item.rule_id === rule.id);
      const saved = rules.some((item) => item.id === rule.id);
      const running = status && status.state !== 'failed';
      return <article className={`port-forward-card${saved ? '' : ' runtime-only'}`} key={rule.id}>
        <div className="port-forward-card-head"><strong>{rule.name}</strong><span className={`port-forward-state ${status?.state ?? 'stopped'}`}>{status?.state === 'listening' ? '正在监听' : status?.state === 'stopping' ? '停止中' : status?.state === 'failed' ? '失败' : '已停止'}</span></div>
        {!saved && <div className="port-forward-notice">规则已从保存配置中删除；当前终端仍保留此实例，停止后将移除此卡片。</div>}
        <div className="port-forward-route"><code>{localAddress(rule.local_host, rule.local_port)}</code><span>→</span><code>{localAddress(rule.remote_host, rule.remote_port)}</code></div>
        {status && (status.local_host !== rule.local_host || status.local_port !== rule.local_port || status.remote_host !== rule.remote_host || status.remote_port !== rule.remote_port) && <div className="port-forward-notice">当前实例：{localAddress(status.local_host, status.local_port)} → {localAddress(status.remote_host, status.remote_port)}；停止后重启以应用保存的配置。</div>}
        {status?.last_error && <div className="port-forward-card-error">{status.last_error}</div>}
        {!isLoopback(rule.local_host) && <div className="port-forward-warning">此监听地址可能允许其他设备访问</div>}
        <div className="port-forward-actions"><button type="button" onClick={() => void run(async () => { await writeClipboardText(localAddress(status?.local_host ?? rule.local_host, status?.local_port ?? rule.local_port)); setCopied(rule.id); })} disabled={pending} title="复制本地地址"><Copy size={14} />{copied === rule.id ? '已复制' : '复制本地地址'}</button>{(running || (!saved && status)) ? <button type="button" onClick={() => void run(() => onStop(rule.id, status.instance_id))} disabled={unavailable || status.state === 'stopping'}><Square size={14} />停止</button> : <button type="button" onClick={() => void run(() => onStart(rule.id))} disabled={unavailable}><Play size={14} />启动</button>}<button type="button" onClick={() => void run(async () => { if (status) await onStop(rule.id, status.instance_id); setEditing({ id: rule.id, form: portForwardForm(rule) }); })} disabled={!saved || !canConfigure || pending || status?.state === 'stopping'}><Pencil size={14} />编辑</button><button type="button" onClick={() => void run(() => onSave(rules.filter((item) => item.id !== rule.id), rule.id))} disabled={!saved || !canConfigure || pending || status?.state === 'stopping'} aria-label={`删除 ${rule.name}`} title="删除规则"><Trash2 size={14} /></button></div>
      </article>;
    })}</div>
    {editing && <form className="port-forward-editor" aria-label="SSH 隧道规则" onSubmit={(event) => { event.preventDefault(); void persist(false); }}><div className="port-forward-editor-head"><strong>{rules.some((rule) => rule.id === editing.id) ? '编辑隧道' : '新增隧道'}</strong><button type="button" onClick={() => setEditing(null)} disabled={pending} aria-label="取消编辑"><X size={16} /></button></div><label>名称<input autoFocus value={editing.form.name} disabled={pending} onChange={(event) => update('name', event.target.value)} /></label><div className="port-forward-fields"><label>本地监听地址<input value={editing.form.local_host} disabled={pending} onChange={(event) => update('local_host', event.target.value)} placeholder="127.0.0.1" /></label><label>本地端口号<input inputMode="numeric" value={editing.form.local_port} disabled={pending} onChange={(event) => update('local_port', event.target.value)} /></label><label>远程目标地址<input value={editing.form.remote_host} disabled={pending} onChange={(event) => update('remote_host', event.target.value)} placeholder="server.example.com" /></label><label>远程端口号<input inputMode="numeric" value={editing.form.remote_port} disabled={pending} onChange={(event) => update('remote_port', event.target.value)} /></label></div>{isIpAddress(editing.form.local_host.trim()) && !isLoopback(editing.form.local_host.trim()) && <div className="port-forward-warning">非回环监听可能暴露给其他设备，请确认这是预期设置。</div>}<div className="port-forward-actions port-forward-save"><button type="submit" disabled={pending || !canConfigure}><Save size={15} />保存</button><button type="button" onClick={() => void persist(true)} disabled={unavailable || !canConfigure}><Play size={15} />保存并启用</button></div></form>}
  </aside>;
}
