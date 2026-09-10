import type { Session } from './api';

export type SessionFilter = {
  query?: string;
  group?: string;
  tag?: string;
};

export function normalizeSessionText(value: string): string {
  return value.trim().toLowerCase();
}

export function sessionGroups(sessions: readonly Session[]): string[] {
  return [...new Set(sessions.map((session) => session.group.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function sessionTags(sessions: readonly Session[]): string[] {
  return [...new Set(sessions.flatMap((session) => session.tags.map((tag) => tag.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b));
}

export function filterSessions(sessions: readonly Session[], filter: SessionFilter): Session[] {
  const query = normalizeSessionText(filter.query ?? '');
  const group = filter.group?.trim() ?? '';
  const tag = filter.tag?.trim() ?? '';
  return sessions.filter((session) => {
    if (group && session.group !== group) return false;
    if (tag && !session.tags.includes(tag)) return false;
    if (!query) return true;
    return [session.name, session.host, session.username, session.group, ...session.tags]
      .some((value) => normalizeSessionText(value).includes(query));
  });
}

export function toggleSessionSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectVisibleSessions(selected: ReadonlySet<string>, visible: readonly Session[]): Set<string> {
  const next = new Set(selected);
  const allSelected = visible.length > 0 && visible.every((session) => next.has(session.id));
  visible.forEach((session) => allSelected ? next.delete(session.id) : next.add(session.id));
  return next;
}

export function normalizeSessionMetadata(session: Session): Session {
  const group = session.group.trim() || 'Custom';
  const tags = [...new Set(session.tags.map((tag) => tag.trim()).filter(Boolean))];
  return { ...session, group, tags };
}
