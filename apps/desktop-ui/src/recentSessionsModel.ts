import type { Session } from './api';

export function recentSessions(sessions: Session[], limit = 5): Session[] {
  return [...sessions]
    .sort((a, b) => {
      const aTime = Date.parse(a.last_connected_at ?? '');
      const bTime = Date.parse(b.last_connected_at ?? '');
      const aHasTime = Number.isFinite(aTime);
      const bHasTime = Number.isFinite(bTime);

      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
      if (aHasTime && bHasTime && aTime !== bTime) return bTime - aTime;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit));
}
