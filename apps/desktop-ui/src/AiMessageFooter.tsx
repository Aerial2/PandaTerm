import { useState } from 'react';
import { Check, Clock, Copy } from 'lucide-react';
import { writeClipboardText } from './api';
import { setStatusMessage } from './appShellStore';
import type { AiMessage } from './aiRuntime';
import { aiOutputTokenRate, formatAiDuration, formatAiTokens } from './aiMessageStats';

export function AiMessageFooter({ message }: { message: AiMessage }) {
  const [copiedContent, setCopiedContent] = useState<string | null>(null);
  const copied = copiedContent === message.content;
  const duration = formatAiDuration(message.durationMs);
  const rate = aiOutputTokenRate(message);

  async function copyContent() {
    try {
      await writeClipboardText(message.content);
      setCopiedContent(message.content);
      setStatusMessage('已复制回复');
    } catch (error) {
      setStatusMessage(`复制回复失败：${String(error)}`);
    }
  }

  return (
    <div className="ai-message-footer">
      <button type="button" aria-label={copied ? '已复制回复' : '复制回复'} title={copied ? '已复制回复' : '复制回复'} onClick={() => void copyContent()}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {rate && <span title="输出 token 数 / 请求总耗时">{rate}</span>}
      {message.usage && <span title={`输入 ${message.usage.input_tokens} · 输出 ${message.usage.output_tokens}`}>{formatAiTokens(message.usage.total_tokens)}</span>}
      {duration && <span><Clock size={13} />{duration}</span>}
    </div>
  );
}
