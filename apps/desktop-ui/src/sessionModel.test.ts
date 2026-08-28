import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import {
  filterSessions,
  normalizeSessionMetadata,
  selectVisibleSessions,
  sessionGroups,
  sessionTags,
  toggleSessionSelection,
} from './sessionModel';

function session(id: string, group: string, tags: string[]): Session {
  return {
    id, name: `Node ${id}`, group, protocol: 'ssh', host: `${id}.example`, port: 22,
    username: 'root', auth: { type: 'agent' }, tags, last_connected_at: null,
    reconnect: { enabled: true, max_attempts: 3, delay_ms: 1500 },
  };
}

describe('sessionModel', () => {
  const sessions = [session('a', 'Prod', ['critical', 'linux']), session('b', 'Test', ['linux'])];

  it('filters by query, group, and tag', () => {
    expect(filterSessions(sessions, { query: 'EXAMPLE' }).map((item) => item.id)).toEqual(['a', 'b']);
    expect(filterSessions(sessions, { group: 'Prod' }).map((item) => item.id)).toEqual(['a']);
    expect(filterSessions(sessions, { tag: 'linux', query: 'node b' }).map((item) => item.id)).toEqual(['b']);
  });

  it('returns stable unique groups and tags', () => {
    expect(sessionGroups(sessions)).toEqual(['Prod', 'Test']);
    expect(sessionTags(sessions)).toEqual(['critical', 'linux']);
  });

  it('toggles and selects only visible sessions', () => {
    expect([...toggleSessionSelection(new Set(['a']), 'a')]).toEqual([]);
    expect([...selectVisibleSessions(new Set(), sessions)]).toEqual(['a', 'b']);
    expect([...selectVisibleSessions(new Set(['a', 'b']), sessions)]).toEqual([]);
  });

  it('normalizes group and de-duplicates tags', () => {
    expect(normalizeSessionMetadata(session('a', '  Prod ', [' linux ', '', 'linux ']))).toMatchObject({
      group: 'Prod', tags: ['linux'],
    });
  });
});
