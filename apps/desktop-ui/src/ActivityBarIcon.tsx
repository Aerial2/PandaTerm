import type { CSSProperties } from 'react';

import aiIcon from './assets/activity/ai.svg';
import filesIcon from './assets/activity/files.svg';
import processesIcon from './assets/activity/processes.svg';
import resourceMonitorIcon from './assets/activity/resource-monitor.svg';

type ActivityBarIconName = 'ai' | 'files' | 'processes' | 'resource-monitor';

type ActivityBarIconProps = {
  name: ActivityBarIconName;
  size?: number;
  className?: string;
  title?: string;
};

const ACTIVITY_ICON_URLS: Record<ActivityBarIconName, string> = {
  ai: aiIcon,
  files: filesIcon,
  processes: processesIcon,
  'resource-monitor': resourceMonitorIcon,
};

const ACTIVITY_ICON_ASPECT_RATIOS: Record<ActivityBarIconName, number> = {
  ai: 1069 / 1024,
  files: 1,
  processes: 1,
  'resource-monitor': 1,
};

export function ActivityBarIcon({ name, size = 20, className, title }: ActivityBarIconProps) {
  const aspectRatio = ACTIVITY_ICON_ASPECT_RATIOS[name];

  return (
    <span
      className={className ? `activity-bar-icon-glyph ${className}` : 'activity-bar-icon-glyph'}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        width: `${size * aspectRatio}px`,
        height: `${size}px`,
        '--activity-icon-url': `url("${ACTIVITY_ICON_URLS[name]}")`,
      } as CSSProperties}
    />
  );
}
