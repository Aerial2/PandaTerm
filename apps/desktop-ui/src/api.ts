import { invoke } from '@tauri-apps/api/core';

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
