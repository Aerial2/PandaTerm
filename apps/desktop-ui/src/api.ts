import { invoke } from '@tauri-apps/api/core';

export async function openConnectionWindow(mode: 'manage' | 'create') {
  const { WebviewWindow, getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = mode === 'create' ? 'connection-create' : 'connection-panel';
  const payload = { mode, target: label };

  // If the window already exists, focus it and send mode event
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.emit('connection-window-set-mode', payload);
    await existing.setFocus();
    return;
  }

  const windowOpts = mode === 'create'
    ? { width: 640, height: 520, minWidth: 520, minHeight: 420 }
    : { width: 880, height: 560, minWidth: 720, minHeight: 480 };

  // Position the new window centered over the window that opened it, so it
  // shows up on the same monitor (and in the middle of that window) instead of
  // snapping back to the primary display.
  let windowPosition: { x: number; y: number } | { center: true };
  try {
    const parent = getCurrentWebviewWindow();
    const scale = await parent.scaleFactor();
    const parentPos = await parent.outerPosition();
    const parentSize = await parent.outerSize();
    const logicalX = parentPos.x / scale;
    const logicalY = parentPos.y / scale;
    const logicalW = parentSize.width / scale;
    const logicalH = parentSize.height / scale;
    windowPosition = {
      x: Math.round(logicalX + (logicalW - windowOpts.width) / 2),
      y: Math.round(logicalY + (logicalH - windowOpts.height) / 2),
    };
  } catch (e) {
    windowPosition = { center: true };
  }

  // Create new window
  const devUrl = import.meta.env.DEV
    ? `http://localhost:1420?mode=connection`
    : undefined;
  const entry = import.meta.env.DEV
    ? undefined
    : `index.html?mode=connection`;

  const webviewWindow = new WebviewWindow(label, {
    url: devUrl ?? entry!,
    title: mode === 'create' ? '新建连接 — PandaTerm' : '连接管理 — PandaTerm',
    ...windowOpts,
    ...('x' in windowPosition ? windowPosition : { center: true }),
    resizable: true,
    decorations: false,
    transparent: false,
    visible: false,
  });

  // Wait for window to be created then send mode
  await webviewWindow.once('tauri://created', async () => {
    await webviewWindow.emit('connection-window-set-mode', payload);
  });

  webviewWindow.once('tauri://error', (e) => {
    console.error('Connection window error:', e);
  });
}

export type AuthType =
  | { type: 'password'; secret_id: string }
  | { type: 'private_key'; key_id: string; passphrase_secret_id?: string | null }
  | { type: 'keyboard_interactive'; response_secret_id: string }
  | { type: 'gssapi'; principal?: string | null }
  | { type: 'agent' };

export type Session = {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: AuthType;
  tags: string[];
  last_connected_at?: string | null;
  reconnect: {
    enabled: boolean;
    max_attempts: number;
    delay_ms: number;
  };
};

export type TerminalEvent = {
  session_id: string;
  kind: 'connected' | 'output' | 'error' | 'disconnected';
  payload: string;
};

export type LocalTerminalWriteResponse = {
  event: TerminalEvent;
  cwd?: string | null;
  prompt: string;
  clear: boolean;
};

export type LocalDirectoryEntry = {
  name: string;
  path: string;
  entry_type: 'directory' | 'file';
  size: number;
  modified_ms?: number | null;
};

export type LocalDirectoryListing = {
  path: string;
  parent?: string | null;
  entries: LocalDirectoryEntry[];
};

export type LocalFilePreview = {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
};

export type LocalTerminalProfile = {
  terminal_id: string;
  os: string;
  shell_name: string;
  cwd: string;
  prompt: string;
  banner: string[];
};

export type TerminalOutputEvent = {
  terminal_id: string;
  payload: string;
};

const fallbackLocalTerminalProfile: LocalTerminalProfile = {
  terminal_id: '',
  os: navigator.platform.toLowerCase().includes('mac') ? 'macos' : 'windows',
  shell_name: navigator.platform.toLowerCase().includes('mac') ? 'zsh' : 'PowerShell',
  cwd: navigator.platform.toLowerCase().includes('mac') ? '/Users' : 'E:\\Project\\Rust\\PandaTerm',
  prompt: navigator.platform.toLowerCase().includes('mac') ? '/Users $' : 'PS E:\\Project\\Rust\\PandaTerm>',
  banner: [],
};

export async function listLocalDirectory(path?: string | null): Promise<LocalDirectoryListing> {
  return await invoke<LocalDirectoryListing>('list_local_directory', { path: path ?? null });
}

export async function readLocalFilePreview(path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_local_file_preview', { path });
}

export async function getLocalTerminalProfile(): Promise<LocalTerminalProfile> {
  return await invoke<LocalTerminalProfile>('local_terminal_profile_command');
}

export async function startLocalTerminal(cwd?: string | null, cols?: number, rows?: number): Promise<LocalTerminalProfile> {
  return await invoke<LocalTerminalProfile>('local_terminal_start', {
    request: { cwd: cwd ?? null, cols: cols ?? null, rows: rows ?? null },
  });
}

export async function sendLocalTerminalInput(terminalId: string, data: string): Promise<void> {
  await invoke('local_terminal_input', { request: { terminal_id: terminalId, data } });
}

export async function resizeLocalTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await invoke('local_terminal_resize', { request: { terminal_id: terminalId, cols, rows } });
}

export async function stopLocalTerminal(terminalId: string): Promise<void> {
  await invoke('local_terminal_stop', { terminalId });
}

export async function localTerminalWrite(data: string, cwd?: string | null): Promise<LocalTerminalWriteResponse> {
  return await invoke<LocalTerminalWriteResponse>('local_terminal_write', {
    request: { data, cwd: cwd ?? null },
  });
}

export async function listSessions(): Promise<Session[]> {
  return await invoke<Session[]>('list_sessions');
}

export async function saveSession(session: Session): Promise<Session[]> {
  return await invoke<Session[]>('save_session', { session });
}

export async function deleteSession(sessionId: string): Promise<Session[]> {
  return await invoke<Session[]>('delete_session', { sessionId });
}

export async function reorderSessions(orderedIds: string[]): Promise<Session[]> {
  return await invoke<Session[]>('reorder_sessions', { orderedIds });
}

export async function connectSession(sessionId: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('connect_session', { sessionId });
}

export async function disconnectSession(terminalId: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('disconnect_session', { terminalId });
}

export async function terminalWrite(terminalId: string, data: string): Promise<TerminalEvent> {
  return await invoke<TerminalEvent>('terminal_write', {
    request: { terminal_id: terminalId, data },
  });
}

export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await invoke('terminal_resize', { request: { terminal_id: terminalId, cols, rows } });
}

export async function listRemoteDirectory(terminalId: string, path?: string | null): Promise<LocalDirectoryListing> {
  return await invoke<LocalDirectoryListing>('list_remote_directory', { terminalId, path: path ?? null });
}

export async function readRemoteFilePreview(terminalId: string, path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_remote_file_preview', { terminalId, path });
}

export async function readLocalFileFull(path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_local_file_full', { path });
}

export async function readRemoteFileFull(terminalId: string, path: string): Promise<LocalFilePreview> {
  return await invoke<LocalFilePreview>('read_remote_file_full', { terminalId, path });
}

export async function writeLocalFile(path: string, content: string): Promise<void> {
  await invoke('write_local_file', { path, content });
}

export async function writeRemoteFile(terminalId: string, path: string, content: string): Promise<void> {
  await invoke('write_remote_file', { terminalId, path, content });
}

export async function uploadFile(fileName: string, content: Uint8Array, destDir: string, transferId: string, terminalId?: string | null): Promise<string> {
  // Encode as base64 to avoid Tauri IPC corruption with large binary arrays.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < content.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(content.subarray(i, i + chunkSize)));
  }
  const contentBase64 = btoa(binary);
  return await invoke<string>('upload_file', {
    terminalId: terminalId ?? null,
    fileName,
    contentBase64,
    destDir,
    transferId,
  });
}

/// Stream-upload a local file to a remote directory. The Rust backend reads
/// the file in chunks and pipes it through SSH, so we avoid base64-encoding
/// large files on the JS side (which blocks the UI and freezes progress).
/// Only works for remote uploads (requires a connected terminalId).
export async function uploadLocalFile(localPath: string, destDir: string, transferId: string, terminalId: string): Promise<string> {
  return await invoke<string>('upload_local_file', {
    terminalId,
    localPath,
    destDir,
    transferId,
  });
}

export type UploadDirectoryResult = {
  remote_path: string;
  files_uploaded: number;
  dirs_created: number;
  total_bytes: number;
  failed_items: string[];
};

/// Recursively upload a local directory to a remote server.
/// Creates directory structure on remote and uploads all files.
export async function uploadDirectory(localDir: string, destDir: string, terminalId: string): Promise<UploadDirectoryResult> {
  return await invoke<UploadDirectoryResult>('upload_directory', {
    terminalId,
    localDir,
    destDir,
  });
}

export async function readFileAsDataUrl(path: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('read_file_as_data_url', {
    terminalId: terminalId ?? null,
    path,
  });
}

export async function downloadRemoteFile(terminalId: string, remotePath: string, localDir: string): Promise<string> {
  return await invoke<string>('download_remote_file', { terminalId, remotePath, localDir });
}

export async function extractArchive(archivePath: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('extract_archive', {
    terminalId: terminalId ?? null,
    archivePath,
  });
}

export async function createArchive(sourcePath: string, terminalId?: string | null): Promise<string> {
  return await invoke<string>('create_archive', {
    terminalId: terminalId ?? null,
    sourcePath,
  });
}

export async function deletePath(path: string, terminalId?: string | null): Promise<void> {
  await invoke('delete_path', { terminalId: terminalId ?? null, path });
}

export async function createFile(path: string, terminalId?: string | null): Promise<void> {
  await invoke('create_file', { terminalId: terminalId ?? null, path });
}

export async function createDirectory(path: string, terminalId?: string | null): Promise<void> {
  await invoke('create_directory', { terminalId: terminalId ?? null, path });
}

export async function copyPath(source: string, destDir: string, terminalId?: string | null, destName?: string): Promise<string> {
  return await invoke<string>('copy_path', { terminalId: terminalId ?? null, source, destDir, destName: destName ?? null });
}

export async function movePath(source: string, destDir: string, terminalId?: string | null, destName?: string): Promise<string> {
  return await invoke<string>('move_path', { terminalId: terminalId ?? null, source, destDir, destName: destName ?? null });
}

export async function getLocalIpv4(): Promise<string> {
  return await invoke<string>('get_local_ipv4');
}

export interface SystemMonitorData {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel_version: string;
  uptime_seconds: number;
  cpu_count: number;
  cpu_usage_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_available_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_available_bytes: number;
  load_avg_1min: number;
  load_avg_5min: number;
  load_avg_15min: number;
  cpu_model: string;
  network_rx_bytes: number;
  network_tx_bytes: number;
  processes: number;
}

export async function getSystemMonitor(terminalId?: string | null): Promise<SystemMonitorData> {
  return await invoke<SystemMonitorData>('get_system_monitor', { terminalId: terminalId ?? null });
}

export interface ProcessInfo {
  pid: number;
  name: string;
  status: string;
  cpu_usage_percent: number;
  memory_bytes: number;
  disk_bytes_per_sec: number;
  network_bytes_per_sec: number;
}

export async function getProcessList(terminalId?: string | null): Promise<ProcessInfo[]> {
  return await invoke<ProcessInfo[]>('get_process_list', { terminalId: terminalId ?? null });
}
