/**
 * 文件资源 / 上传冲突 — 纯数据与工具（无 React）。
 * 从 App.tsx 拆出，避免巨型组件里塞工具函数。
 */
import type { LocalDirectoryEntry } from './api';

export type ResourceFile = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: string;
  sizeBytes: number;
  modifiedTime: string;
};

export type UploadConflictAction = 'overwrite' | 'skip' | 'rename';

export type UploadConflictDecision = {
  action: UploadConflictAction;
  newName?: string;
};

export type UploadConflictDialogState = {
  sourceName: string;
  sourceSize: number;
  sourceModifiedMs?: number | null;
  target: ResourceFile;
  existingNames: string[];
  action: UploadConflictAction;
  newName: string;
  applyToAll: boolean;
  resolve: (decision: UploadConflictDecision | null) => void;
};

export type UploadConflictApplyAll = {
  action: UploadConflictAction;
};

export type ResourceSortKey = 'name' | 'size' | 'modifiedTime';

export type InlineRenameState = {
  path: string;
  originalName: string;
  value: string;
  type: ResourceFile['type'];
  submitting: boolean;
};

export const RESOURCE_RENAME_SECOND_CLICK_DELAY_MS = 500;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar']);

export function getFileExt(name: string): string {
  const lower = name.toLowerCase();
  for (const compound of ['.tar.gz', '.tar.bz2', '.tar.xz']) {
    if (lower.endsWith(compound)) return compound.slice(1);
  }
  const idx = lower.lastIndexOf('.');
  return idx > 0 ? lower.slice(idx + 1) : '';
}

export function getMediaKind(name: string): 'image' | 'video' | 'audio' | null {
  const ext = getFileExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

export function isArchive(name: string): boolean {
  return ARCHIVE_EXTS.has(getFileExt(name));
}

export function formatFileSize(size: number) {
  if (size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatModifiedTime(modifiedMs?: number | null) {
  if (!modifiedMs) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(modifiedMs));
}

export function joinRemotePath(dir: string, name: string) {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function splitUploadRelativePath(path: string) {
  const slash = path.lastIndexOf('/');
  return slash >= 0
    ? { parent: path.slice(0, slash), name: path.slice(slash + 1) }
    : { parent: '', name: path };
}

export function buildDuplicateName(name: string, existingNames: Set<string>) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export function toResourceFile(entry: LocalDirectoryEntry): ResourceFile {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.entry_type,
    size: entry.entry_type === 'directory' ? '-' : formatFileSize(entry.size),
    sizeBytes: entry.size,
    modifiedTime: formatModifiedTime(entry.modified_ms),
  };
}

export function compareResource(a: ResourceFile, b: ResourceFile, key: ResourceSortKey) {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  if (key === 'size') return a.sizeBytes - b.sizeBytes;
  return a[key].localeCompare(b[key], 'zh-Hans-CN', { numeric: true });
}

export function clampPanelWidth(width: number) {
  return Math.min(68, Math.max(24, width));
}

export function buildPathBreadcrumbs(path: string) {
  const normalized = path.trim();
  if (!normalized) return [];

  if (normalized === '此电脑') return [{ label: '此电脑', path: '此电脑' }];

  const windowsDriveMatch = normalized.match(/^([A-Za-z]:\\)(.*)$/);
  if (windowsDriveMatch) {
    const root = windowsDriveMatch[1];
    const segments = windowsDriveMatch[2].split('\\').filter(Boolean);
    const crumbs = [{ label: '此电脑', path: '此电脑' }, { label: root, path: root }];
    let current = root;

    segments.forEach((segment) => {
      current = current.endsWith('\\') ? `${current}${segment}` : `${current}\\${segment}`;
      crumbs.push({ label: segment, path: current });
    });

    return crumbs;
  }

  const segments = normalized.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];

  segments.forEach((segment, index) => {
    crumbs.push({ label: segment, path: `/${segments.slice(0, index + 1).join('/')}` });
  });

  return crumbs;
}