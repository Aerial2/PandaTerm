import { type ITheme } from '@xterm/xterm';

import type { LocalTerminalProfile, Session } from './api';

export const oneDarkProTerminalTheme: ITheme = {
  background: '#23272e',
  foreground: '#e6e6e6',
  cursor: '#61afef',
  selectionBackground: 'rgba(97, 175, 239, 0.15)',
  black: '#23272e',
  blue: '#61afef',
  cyan: '#56b6c2',
  green: '#98c379',
  magenta: '#c678dd',
  red: '#e06c75',
  white: '#e6e6e6',
  yellow: '#e5c07b',
  brightBlack: '#6c7086',
  brightBlue: '#61afef',
  brightCyan: '#56b6c2',
  brightGreen: '#98c379',
  brightMagenta: '#c678dd',
  brightRed: '#e06c75',
  brightWhite: '#e6e6e6',
  brightYellow: '#e5c07b',
};

export const localSession: Session = {
  id: 'local-system',
  name: '本地系统',
  group: 'Local',
  host: 'localhost',
  port: 0,
  username: 'local',
  auth: { type: 'agent' },
  tags: ['local', 'system'],
  last_connected_at: null,
  reconnect: { enabled: false, max_attempts: 0, delay_ms: 0 },
};

export const isFallbackMac = navigator.userAgent.toLowerCase().includes('mac');

export const fallbackLocalTerminalProfile: LocalTerminalProfile = {
  terminal_id: '',
  os: isFallbackMac ? 'macos' : 'windows',
  shell_name: isFallbackMac ? 'zsh' : 'PowerShell',
  cwd: isFallbackMac ? '/Users' : 'E:\\Project\\Rust\\PandaTerm',
  prompt: isFallbackMac ? '/Users $' : 'PS E:\\Project\\Rust\\PandaTerm>',
  banner: [],
};
