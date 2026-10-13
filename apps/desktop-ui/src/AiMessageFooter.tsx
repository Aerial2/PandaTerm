import { useState } from 'react';
import { Check, Clock, Copy } from 'lucide-react';
import { writeClipboardText } from './api';
import { setStatusMessage } from './appShellStore';
import type { AiMessage } from './aiRuntime';
import { aiOutputTokenRate, formatAiDuration, formatAiFirstTokenDuration, formatAiTokens } from './aiMessageStats';

export function AiMessageFooter({ message }: { message: AiMessage }) {
  const [copiedContent, setCopiedContent] = useState<string | null>(null);
  const copied = copiedContent === message.content;
  const duration = formatAiDuration(message.durationMs);
  const firstTokenDuration = formatAiFirstTokenDuration(message.firstTokenDurationMs);
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
      <span title={rate ? '输出 token 数 / 首字后生成耗时' : '缺少 token 用量或首字后生成耗时，暂无法计算速度'}>{rate ?? '-- token/s'}</span>
      <span title={message.usage ? `输入 ${message.usage.input_tokens} · 输出 ${message.usage.output_tokens}` : '服务未返回 token 用量'}>{message.usage ? formatAiTokens(message.usage.total_tokens) : '-- tokens'}</span>
      {firstTokenDuration && <span title="从发送请求到收到首个文本输出">首字 {firstTokenDuration}</span>}
      {duration && <span><Clock size={13} />{duration}</span>}
    </div>
  );
}
