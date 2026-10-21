export type ActivityPanel = 'recent' | 'files' | 'monitor' | 'processes' | 'ai' | 'manual' | 'tunnels';

export type LeftActivity = ActivityPanel | null;

export type TerminalActivityLevel = 'info' | 'warn' | 'error';

export type TerminalActivityEntry = {
  time: string;
  level: TerminalActivityLevel;
  text: string;
};
