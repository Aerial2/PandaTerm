import type { Protocol, RecentFile } from './api';

export type { RecentFile } from './api';

export type RecentFileFilter = {
  query?: string;
  sessionId?: string;
  protocol?: Protocol;
  host?: string;
};

export type RecentFileServerIdentity = Pick<
  RecentFile,
  'session_id' | 'protocol' | 'host' | 'port' | 'username'
>;

export function normalizeRecentFile(file: RecentFile): RecentFile {
  const normalizedDisplayPath = file.path.trim().replace(/\\/g, '/');
  return {
    ...file,
    name: file.name.trim() || normalizedDisplayPath.split('/').pop() || file.path,
    kind: file.kind.trim() || 'file',
  };
}

/** Stable identity matching the backend's endpoint-plus-path key. */
export function recentFileIdentity(file: Pick<RecentFile, 'session_id' | 'protocol' | 'host' | 'port' | 'username' | 'path'>): string {
  return JSON.stringify([file.session_id, file.protocol, file.host, file.port, file.username, file.path]);
}

function sameServerEndpoint(left: RecentFileServerIdentity, right: RecentFileServerIdentity): boolean {
  return left.protocol === right.protocol
    && left.host === right.host
    && left.port === right.port
    && left.username === right.username;
}

/** Matches an active server exactly, or an endpoint whose previous session is no longer active. */
export function recentFileMatchesServer(
  file: RecentFileServerIdentity,
  server: RecentFileServerIdentity,
  currentSessionIds: readonly string[] | null,
): boolean {
  if (file.session_id === server.session_id) return sameServerEndpoint(file, server);
  return currentSessionIds !== null
    && sameServerEndpoint(file, server)
    && !currentSessionIds.includes(file.session_id);
}

export function dedupeRecentFiles(files: readonly RecentFile[]): RecentFile[] {
  const seen = new Set<string>();
  const result: RecentFile[] = [];
  for (const file of files) {
    const normalized = normalizeRecentFile(file);
    const identity = recentFileIdentity(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(normalized);
  }
  return result;
}

export function upsertRecentFile(files: readonly RecentFile[], file: RecentFile): RecentFile[] {
  const normalized = normalizeRecentFile(file);
  return [normalized, ...dedupeRecentFiles(files).filter((item) => recentFileIdentity(item) !== recentFileIdentity(normalized))];
}

export function filterRecentFiles(files: readonly RecentFile[], filter: RecentFileFilter = {}): RecentFile[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  const sessionId = filter.sessionId?.trim() ?? '';
  const host = filter.host?.trim().toLowerCase() ?? '';
  return files.filter((file) => {
    if (sessionId && file.session_id !== sessionId) return false;
    if (filter.protocol && file.protocol !== filter.protocol) return false;
    if (host && file.host.toLowerCase() !== host) return false;
    if (!query) return true;
    return [file.path, file.name, file.host, file.username].some((value) => value.toLowerCase().includes(query));
  });
}
