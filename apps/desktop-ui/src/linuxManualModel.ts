import { isTauri } from '@tauri-apps/api/core';
import { openExternalUrl } from './aboutModel';
import indexData from './data/linux-command/index.json';
import licenseText from './data/linux-command/LICENSE?raw';

export type LinuxManualEntry = { id: string; name: string; description: string };

export const LINUX_MANUAL_SOURCE_COMMIT = 'cd17682d612e6fdfaff29261c11ffbc3f951f41d';
export const LINUX_MANUAL_SOURCE_URL = `https://github.com/jaywcjlove/linux-command/tree/${LINUX_MANUAL_SOURCE_COMMIT}`;

export function isLinuxManualId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(id) && id !== '.' && id !== '..';
}

export function validateLinuxManualIndex(value: unknown): LinuxManualEntry[] {
  if (!Array.isArray(value)) throw new Error('命令索引格式无效');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('命令索引条目无效');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !isLinuxManualId(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || typeof item.description !== 'string') {
      throw new Error('命令索引条目无效或重复');
    }
    ids.add(item.id);
    return { id: item.id, name: item.name, description: item.description };
  });
}

export const linuxManualIndex: readonly LinuxManualEntry[] = validateLinuxManualIndex(indexData);
const documents = import.meta.glob<string>('./data/linux-command/docs/*.md', { query: '?raw', import: 'default' });
export const linuxManualLicense = licenseText;
export const linuxManualDocumentIds = Object.keys(documents).map((path) => path.slice(path.lastIndexOf('/') + 1, -3));
const documentCache = new Map<string, Promise<string>>();

export function searchLinuxManual(query: string, entries: readonly LinuxManualEntry[] = linuxManualIndex): LinuxManualEntry[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [...entries];
  function rank(entry: LinuxManualEntry): number {
    const name = entry.name.toLocaleLowerCase();
    const id = entry.id.toLocaleLowerCase();
    if (name === term || id === term) return 0;
    if (name.startsWith(term) || id.startsWith(term)) return 1;
    if (name.includes(term) || id.includes(term)) return 2;
    return entry.description.toLocaleLowerCase().includes(term) ? 3 : 4;
  }
  return entries.map((entry, order) => ({ entry, order, rank: rank(entry) }))
    .filter((item) => item.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((item) => item.entry);
}

export function loadLinuxManualDocument(id: string): Promise<string> {
  if (!isLinuxManualId(id) || !linuxManualIndex.some((entry) => entry.id === id)) {
    return Promise.reject(new Error('未找到该命令的文档'));
  }
  const cached = documentCache.get(id);
  if (cached) return cached;
  const loader = documents[`./data/linux-command/docs/${id}.md`];
  if (!loader) return Promise.reject(new Error('该命令的文档不可用'));
  const pending = loader().catch((error: unknown) => {
    documentCache.delete(id);
    throw error;
  });
  documentCache.set(id, pending);
  return pending;
}

export type LinuxManualLink =
  | { kind: 'command'; id: string; hash?: string }
  | { kind: 'hash'; hash: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked' };

export function safeLinuxManualExternalUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\u0000- \u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function resolveLinuxManualLink(href: string, entries: readonly LinuxManualEntry[] = linuxManualIndex): LinuxManualLink {
  const external = safeLinuxManualExternalUrl(href);
  if (external) return { kind: 'external', url: external };
  if (href.startsWith('#')) {
    try { return { kind: 'hash', hash: decodeURIComponent(href.slice(1)) }; } catch { return { kind: 'blocked' }; }
  }
  // Only documentation filenames are local links; never resolve arbitrary filesystem paths.
  const match = /^(?:\.\/|\.\.\/docs\/|docs\/)?([^/?#]+)\.(?:md|html)(?:#(.*))?$/i.exec(href);
  if (!match) return { kind: 'blocked' };
  try {
    const id = decodeURIComponent(match[1]);
    if (!isLinuxManualId(id) || !entries.some((entry) => entry.id === id)) return { kind: 'blocked' };
    return { kind: 'command', id, hash: match[2] === undefined ? undefined : decodeURIComponent(match[2]) };
  } catch { return { kind: 'blocked' }; }
}

export async function openLinuxManualExternalUrl(value: string): Promise<boolean> {
  const url = safeLinuxManualExternalUrl(value);
  if (!url) return false;
  if (isTauri()) await openExternalUrl(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** GitHub-style heading IDs, including a per-document counter for duplicate titles. */
export function createLinuxManualHeadingSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  };
}
