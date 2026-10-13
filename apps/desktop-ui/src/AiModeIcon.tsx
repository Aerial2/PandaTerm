import chatIcon from './assets/ai/chat.svg';
import infinityIcon from './assets/ai/infinity.svg';

type AiModeIconProps = {
  mode: 'agent' | 'ask';
  size: number;
  className?: string;
};

export function AiModeIcon({ mode, size, className }: AiModeIconProps) {
  return (
    <img
      src={mode === 'agent' ? infinityIcon : chatIcon}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      draggable={false}
      style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }}
    />
  );
}
