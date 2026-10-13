import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { clearRecentFiles, listRecentFiles, upsertRecentFile, removeRecentFile, type RecentFile } from './api';

const file: RecentFile = {
  session_id: 'prod', protocol: 'ssh', host: 'host.example', port: 22,
  username: 'alice', path: '/srv/app/main.rs', name: 'main.rs', kind: 'file',
  opened_at: '2026-10-12T12:00:00Z',
};

beforeEach(() => vi.mocked(invoke).mockReset());

describe('recent file API', () => {
  it('lists and returns recent files', async () => {
    vi.mocked(invoke).mockResolvedValue([file]);
    expect(await listRecentFiles()).toEqual([file]);
    expect(invoke).toHaveBeenCalledWith('list_recent_files');
  });

  it('upserts the direct file payload and current session IDs', async () => {
    vi.mocked(invoke).mockResolvedValue([file]);
    expect(await upsertRecentFile(file, ['prod', 'test'])).toEqual([file]);
    expect(invoke).toHaveBeenCalledWith('upsert_recent_file', { file, currentSessionIds: ['prod', 'test'] });
  });

  it('removes the full file identity and returns remaining files', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    expect(await removeRecentFile(file)).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('remove_recent_file', { file });
  });

  it('clears supplied recent files and returns remaining files', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    expect(await clearRecentFiles([file])).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('clear_recent_files', { files: [file] });
  });
});
