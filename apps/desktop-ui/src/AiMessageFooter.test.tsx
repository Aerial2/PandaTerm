import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiMessageFooter } from './AiMessageFooter';
import type { AiMessage } from './aiRuntime';

const message: AiMessage = {
  id: 'reply', role: 'assistant', content: '回复', status: 'complete',
  contexts: [], proposals: [], terminalActions: [], mcpActions: [],
  createdAt: '2026-10-13T00:00:00Z', durationMs: 125000, generationDurationMs: 125000, firstTokenDurationMs: 1250,
};

describe('AI message footer', () => {
  it('keeps both token fields visible when the provider omits usage', () => {
    const html = renderToStaticMarkup(<AiMessageFooter message={message} />);
    expect(html).toContain('-- token/s');
    expect(html).toContain('-- tokens');
    expect(html).toContain('2分5秒');
    expect(html).toContain('首字 1.3秒');
    expect(html).toContain('从发送请求到收到首个文本输出');
    expect(html).toContain('服务未返回 token 用量');
  });

  it('shows real token statistics when usage is available', () => {
    const html = renderToStaticMarkup(<AiMessageFooter message={{ ...message,
      usage: { input_tokens: 273375, output_tokens: 7625, total_tokens: 281000 },
    }} />);
    expect(html).toContain('61 token/s');
    expect(html).toContain('281.0k tokens');
    expect(html).not.toContain('-- tokens');
  });
});
