import sendIcon from './assets/ai/send.svg';
import stopIcon from './assets/ai/stop.svg';

type AiSendIconProps = {
  stopped: boolean;
  size?: number;
};

export function AiSendIcon({ stopped, size = 16 }: AiSendIconProps) {
  return (
    <img
      src={stopped ? stopIcon : sendIcon}
      alt=""
      aria-hidden="true"
      width={stopped ? 27 : size}
      height={stopped ? 27 : size}
      draggable={false}
      style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }}
    />
  );
}
