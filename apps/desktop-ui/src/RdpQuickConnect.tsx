import { useState } from 'react';
import { saveSession, type Session } from './api';

// 临时的 RDP 快速连接入口：收集 host / port / username / password，
// 通过 saveSession 写入后端会话库与凭据保险库，再回调 onConnect 打开标签。
// 属于阶段 3 的最小验证入口，后续会被 ConnectionWindow 的协议选择取代。

type RdpQuickConnectProps = {
  onConnect: (session: Session) => void;
};

function buildRdpSession(name: string, host: string, port: number, username: string): Session {
  return {
    id: crypto.randomUUID(),
    name: name || host,
    group: 'RDP',
    protocol: 'rdp',
    host,
    port,
    username,
    domain: null,
    auth: { type: 'password', secret_id: '' },
    tags: [],
    reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
  };
}

export function RdpQuickConnect({ onConnect }: RdpQuickConnectProps) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('3389');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setHost('');
    setPort('3389');
    setUsername('');
    setPassword('');
    setName('');
    setError('');
    setBusy(false);
  }

  async function submit() {
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    const parsedPort = Number.parseInt(port, 10) || 3389;
    if (!trimmedHost) {
      setError('请填写主机地址');
      return;
    }
    if (!trimmedUser) {
      setError('请填写用户名');
      return;
    }
    if (!password) {
      setError('请填写密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = buildRdpSession(name.trim(), trimmedHost, parsedPort, trimmedUser);
      await saveSession(session, password);
      setOpen(false);
      reset();
      onConnect(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="empty-primary-action"
        onClick={() => { reset(); setOpen(true); }}
      >
        <span>RDP 快速连接</span>
      </button>
      {open && (
        <div className="rdp-quick-mask" onClick={() => !busy && setOpen(false)}>
          <div className="rdp-quick-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="rdp-quick-title">连接远程桌面 (RDP)</h3>
            <label className="rdp-quick-field">
              <span>名称</span>
              <input value={name} placeholder="可选" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="rdp-quick-field">
              <span>主机</span>
              <input value={host} placeholder="192.168.1.10" onChange={(e) => setHost(e.target.value)} />
            </label>
            <label className="rdp-quick-field">
              <span>端口</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
            <label className="rdp-quick-field">
              <span>用户名</span>
              <input value={username} placeholder="Administrator" onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="rdp-quick-field">
              <span>密码</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="rdp-quick-error">{error}</div>}
            <div className="rdp-quick-actions">
              <button disabled={busy} onClick={() => setOpen(false)}>取消</button>
              <button className="rdp-quick-primary" disabled={busy} onClick={() => void submit()}>
                {busy ? '连接中...' : '连接'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default RdpQuickConnect;