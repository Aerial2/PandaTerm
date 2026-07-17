import { useSyncExternalStore } from 'react';
import { getStatusMessage, subscribeStatusMessage } from './appShellStore';

function truncateStatus(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

type StatusBarProps = {
  tabCount: number;
};

/** 状态栏独立订阅 status store，setStatusMessage 不再拖垮 App */
export function StatusBar({ tabCount }: StatusBarProps) {
  const statusMessage = useSyncExternalStore(
    subscribeStatusMessage,
    getStatusMessage,
    getStatusMessage,
  );

  return (
    <footer className="status-bar">
      <span title={statusMessage}>{truncateStatus(statusMessage)}</span>
      <span>{tabCount} 个标签页</span>
    </footer>
  );
}