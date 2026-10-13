import chatgptIcon from './assets/ai/chatgpt.svg';
import claudeIcon from './assets/ai/claude.svg';

type AiModelIconProps = {
  model: string;
  apiFormat?: string;
  size?: number;
};

export function AiModelIcon({ model, apiFormat, size = 13 }: AiModelIconProps) {
  const name = model.trim().toLowerCase();
  const isClaude = name.includes('claude') || name.includes('anthropic')
    || (!/gpt|chatgpt|codex|openai|^o[134](?:\b|[-_])/.test(name) && apiFormat === 'claude');

  return (
    <img
      src={isClaude ? claudeIcon : chatgptIcon}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }}
    />
  );
}
