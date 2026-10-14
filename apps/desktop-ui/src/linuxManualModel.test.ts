import { describe, expect, it, vi } from 'vitest';
import { openExternalUrl } from './aboutModel';

vi.mock('./aboutModel', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
import {
  createLinuxManualHeadingSlugger, isLinuxManualId, linuxManualDocumentIds,
  linuxManualIndex, linuxManualLicense, loadLinuxManualDocument,
  openLinuxManualExternalUrl, resolveLinuxManualLink, safeLinuxManualExternalUrl,
  searchLinuxManual, validateLinuxManualIndex,
} from './linuxManualModel';

const entries = [
  { id: 'description', name: 'other', description: '使用 LS 列出文件' },
  { id: 'lsblk', name: 'lsblk', description: '列出块设备' },
  { id: 'false', name: 'false', description: '返回失败状态' },
  { id: 'ls', name: 'ls', description: '列出目录内容' },
];

describe('Linux manual search', () => {
  it('trims and ignores case, ranking exact and name matches before descriptions', () => {
    expect(searchLinuxManual(' LS ', entries).map((entry) => entry.id)).toEqual(['ls', 'lsblk', 'false', 'description']);
  });
  it('matches canonical IDs even when an upstream display name differs', () => {
    const typo = [{ id: 'gcc', name: 'pullgcc', description: 'GNU 编译器' }];
    expect(searchLinuxManual(' GCC ', typo)).toEqual(typo);
    expect(searchLinuxManual('gc', typo)).toEqual(typo);
    expect(searchLinuxManual('gcc').some((entry) => entry.id === 'gcc')).toBe(true);
  });
  it('searches Chinese descriptions and preserves index order for empty input', () => {
    expect(searchLinuxManual('块设备', entries).map((entry) => entry.id)).toEqual(['lsblk']);
    expect(searchLinuxManual('   ', entries)).toEqual(entries);
    expect(searchLinuxManual('does-not-exist', entries)).toEqual([]);
  });
});

describe('Linux manual resource integrity', () => {
  it('has a unique valid index and exactly one document per command', () => {
    expect(linuxManualIndex.length).toBeGreaterThan(100);
    expect(validateLinuxManualIndex(linuxManualIndex)).toEqual(linuxManualIndex);
    expect([...linuxManualDocumentIds].sort()).toEqual(linuxManualIndex.map((entry) => entry.id).sort());
    expect(linuxManualLicense).toContain('MIT License');
    expect(linuxManualLicense).toContain('Permission is hereby granted');
    expect(linuxManualLicense).toContain('THE SOFTWARE IS PROVIDED');
  });
  it('loads and caches ls while refusing identifiers outside the bundled index', async () => {
    const first = loadLinuxManualDocument('ls');
    expect(loadLinuxManualDocument('ls')).toBe(first);
    expect(await first).toContain('ls');
    await expect(loadLinuxManualDocument('../ls')).rejects.toThrow();
    await expect(loadLinuxManualDocument('not-a-bundled-command')).rejects.toThrow();
  });
  it('rejects invalid and duplicate index entries', () => {
    expect(() => validateLinuxManualIndex({})).toThrow();
    expect(() => validateLinuxManualIndex([entries[0], entries[0]])).toThrow();
    expect(() => validateLinuxManualIndex([{ id: '../ls', name: 'ls', description: '' }])).toThrow();
    expect(isLinuxManualId('7z')).toBe(true);
    expect(isLinuxManualId('a/b')).toBe(false);
  });
});

describe('Linux manual links and anchors', () => {
  it('resolves local Markdown and HTML command links and decoded hashes', () => {
    expect(resolveLinuxManualLink('./ls.md#%E5%AE%9E%E4%BE%8B', entries)).toEqual({ kind: 'command', id: 'ls', hash: '实例' });
    expect(resolveLinuxManualLink('ls.html', entries)).toEqual({ kind: 'command', id: 'ls', hash: undefined });
    expect(resolveLinuxManualLink('../docs/ls.md#options', entries)).toEqual({ kind: 'command', id: 'ls', hash: 'options' });
    expect(resolveLinuxManualLink('#%E5%AE%9E%E4%BE%8B', entries)).toEqual({ kind: 'hash', hash: '实例' });
  });
  it('blocks unsafe protocols, traversal, unknown commands, and malformed escapes', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.com', '../../ls.md', '%2e%2e.md', 'missing.md', 'ls.md?download=1', '#%zz']) {
      expect(resolveLinuxManualLink(href, entries)).toEqual({ kind: 'blocked' });
    }
    expect(safeLinuxManualExternalUrl('https://user:password@example.com')).toBeNull();
    expect(safeLinuxManualExternalUrl('https://example.com\n')).toBeNull();
    expect(resolveLinuxManualLink('https://example.com/docs#test', entries)).toEqual({ kind: 'external', url: 'https://example.com/docs#test' });
  });
  it('only opens validated HTTP(S) URLs with opener isolation', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    try {
      expect(await openLinuxManualExternalUrl('javascript:alert(1)')).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(await openLinuxManualExternalUrl('https://example.com')).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    } finally { vi.unstubAllGlobals(); }
  });
  it('uses the native opener on Tauri and propagates async failures', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    vi.stubGlobal('isTauri', true);
    try {
      expect(await openLinuxManualExternalUrl('https://example.com')).toBe(true);
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/');
      expect(open).not.toHaveBeenCalled();
      vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error('native opener failed'));
      await expect(openLinuxManualExternalUrl('https://example.com')).rejects.toThrow('native opener failed');
    } finally { vi.unstubAllGlobals(); }
  });
  it('creates Chinese and formatted heading anchors with collision handling', () => {
    const slug = createLinuxManualHeadingSlugger();
    expect(slug('实例')).toBe('实例');
    expect(slug('Hello, World!')).toBe('hello-world');
    expect(slug('Hello, World!')).toBe('hello-world-1');
    expect(slug('Hello World-1')).toBe('hello-world-1-1');
  });
});
