import { describe, expect, it } from 'vitest';
import {
  dedupeRecentFiles,
  filterRecentFiles,
  normalizeRecentFile,
  recentFileIdentity,
  recentFileMatchesServer,
  upsertRecentFile,
  type RecentFile,
} from './recentFilesModel';

const file = (
  path: string,
  session_id = 'session-1',
  protocol: RecentFile['protocol'] = 'ssh',
  overrides: Partial<RecentFile> = {},
): RecentFile => ({
  session_id,
  protocol,
  host: 'host.example',
  port: 22,
  username: 'alice',
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  kind: 'file',
  opened_at: '2026-10-12T12:00:00Z',
  ...overrides,
});

describe('recentFilesModel', () => {
  it('normalizes display fields without changing backend identity fields', () => {
    expect(normalizeRecentFile(file('  C:\\Work\\main.rs  ', 's1', 'ssh', { name: '  ' }))).toMatchObject({
      path: '  C:\\Work\\main.rs  ', name: 'main.rs', session_id: 's1', protocol: 'ssh',
    });
  });

  it('scopes identity by all backend identity fields', () => {
    const base = file('/work/readme.md');
    expect(recentFileIdentity(base)).toBe(recentFileIdentity({ ...base }));
    expect(recentFileIdentity(base)).not.toBe(recentFileIdentity({ ...base, session_id: 'session-2' }));
    expect(recentFileIdentity(base)).not.toBe(recentFileIdentity({ ...base, protocol: 'rdp' }));
    expect(recentFileIdentity(base)).not.toBe(recentFileIdentity({ ...base, port: 3389 }));
    expect(recentFileIdentity(base)).not.toBe(recentFileIdentity({ ...base, path: '/work/other.md' }));
  });

  it('matches the exact session and endpoint independently of file path', () => {
    const server = file('/current', 'current');
    expect(recentFileMatchesServer(file('/other', 'current'), server, ['current'])).toBe(true);
    for (const changed of [
      { protocol: 'rdp' as const },
      { host: 'HOST.EXAMPLE' },
      { port: 2222 },
      { username: 'Alice' },
    ]) {
      expect(recentFileMatchesServer({ ...server, ...changed }, server, ['current'])).toBe(false);
    }
  });

  it('does not use endpoint fallback while session discovery is unavailable', () => {
    const server = file('/current', 'current');
    expect(recentFileMatchesServer(file('/old', 'old'), server, null)).toBe(false);
    expect(recentFileMatchesServer(file('/old', 'old'), server, [])).toBe(true);
  });

  it('matches a replaced session only when its old UUID is absent', () => {
    const server = file('/current', 'current');
    const old = file('/previous', 'old');
    expect(recentFileMatchesServer(old, server, ['current'])).toBe(true);
    expect(recentFileMatchesServer(old, server, ['current', 'old'])).toBe(false);
    expect(recentFileMatchesServer({ ...old, host: 'other.example' }, server, ['current'])).toBe(false);
    expect(recentFileMatchesServer({ ...old, username: 'bob' }, server, ['current'])).toBe(false);
    expect(recentFileMatchesServer({ ...old, port: 2222 }, server, ['current'])).toBe(false);
    expect(recentFileMatchesServer({ ...old, protocol: 'rdp' }, server, ['current'])).toBe(false);
  });

  it('deduplicates and moves an updated item to the front', () => {
    const original = file('/srv/app/main.rs');
    const duplicate = file('/srv/app/main.rs', 'session-1', 'ssh', { opened_at: '2026-10-12T13:00:00Z' });
    expect(dedupeRecentFiles([original, duplicate])).toHaveLength(1);
    expect(upsertRecentFile([original, file('/tmp/other')], duplicate)).toMatchObject([
      { path: '/srv/app/main.rs', opened_at: '2026-10-12T13:00:00Z' },
      { path: '/tmp/other' },
    ]);
  });

  it('filters by query, session, protocol, and host', () => {
    const files = [
      file('/srv/app/main.rs', 'prod', 'ssh', { name: 'main.rs' }),
      file('/srv/app/readme.md', 'test', 'ssh', { name: 'README.md' }),
      file('/remote/main.rdp', 'desktop', 'rdp', { host: 'desktop.example', port: 3389 }),
    ];
    expect(filterRecentFiles(files, { query: 'README' }).map((item) => item.path)).toEqual(['/srv/app/readme.md']);
    expect(filterRecentFiles(files, { sessionId: 'prod', protocol: 'ssh' })).toHaveLength(1);
    expect(filterRecentFiles(files, { host: 'DESKTOP.EXAMPLE' })).toHaveLength(1);
  });
});
