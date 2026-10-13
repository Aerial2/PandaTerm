import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import { recentSessions } from './recentSessionsModel';

function session(id: string, name: string, last_connected_at?: string | null): Session {
  return {
    id,
    name,
    group: 'Servers',
    host: `${id}.example.test`,
    port: 22,
    username: 'user',
    auth: { type: 'agent' },
    tags: [],
    last_connected_at,
    reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
  };
}

describe('recentSessions', () => {
  it('sorts by latest connection and uses a stable fallback for missing or invalid timestamps', () => {
    const input = [
      session('z', 'Zulu', null),
      session('older', 'Older', '2025-01-01T00:00:00Z'),
      session('invalid', 'Invalid', 'not-a-date'),
      session('newer', 'Newer', '2025-02-01T00:00:00Z'),
      session('alpha', 'Alpha'),
    ];

    expect(recentSessions(input).map(({ id }) => id)).toEqual([
      'newer', 'older', 'alpha', 'invalid', 'z',
    ]);
    expect(input.map(({ id }) => id)).toEqual(['z', 'older', 'invalid', 'newer', 'alpha']);
  });

  it('limits the displayed sessions and accepts a zero limit', () => {
    const input = [session('a', 'Alpha'), session('b', 'Beta')];

    expect(recentSessions(input, 1).map(({ id }) => id)).toEqual(['a']);
    expect(recentSessions(input, 0)).toEqual([]);
  });
});
