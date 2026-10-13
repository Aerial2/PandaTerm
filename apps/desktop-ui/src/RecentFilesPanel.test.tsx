import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RecentFile, Session } from './api';
import { RecentFilesPanel } from './RecentFilesPanel';

const records: RecentFile[] = [
  {
    session_id: 'prod', protocol: 'ssh', host: 'prod.example', port: 22,
    username: 'alice', path: '/srv/app/main.rs', name: 'main.rs', kind: 'file',
    opened_at: '2026-10-12T12:00:00Z',
  },
  {
    session_id: 'prod', protocol: 'ssh', host: 'prod.example', port: 22,
    username: 'alice', path: '/srv/app/config.toml', name: 'config.toml', kind: 'file',
    opened_at: '2026-10-12T11:00:00Z',
  },
];

const sessions: Session[] = [{
  id: 'prod', name: '生产服务器', group: '', protocol: 'ssh', host: 'prod.example', port: 22,
  username: 'alice', auth: { type: 'agent' }, tags: [],
  reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
}];

function render(recordsToRender: RecentFile[], sessionsToRender: Session[] = sessions) {
  return renderToStaticMarkup(
    <RecentFilesPanel
      records={recordsToRender}
      sessions={sessionsToRender}
      loading={false}
      error={null}
      onRemove={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
}

describe('RecentFilesPanel', () => {
  it('shows collapsed server groups using configured server names', () => {
    const html = render(records);
    expect(html).toContain('最近文件');
    expect(html).toContain('生产服务器');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('main.rs');
  });

  it('shows the empty recent-files state when there are no records', () => {
    expect(render([])).toContain('暂无最近文件');
  });

  it('uses the endpoint as a fallback name for removed servers', () => {
    expect(render(records, [])).toContain('alice@prod.example');
  });
});
