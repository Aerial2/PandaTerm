/**
 * AI 助手轻量 Markdown 渲染（无第三方依赖）。
 * 支持：代码块、行内 code、粗体、列表、标题、段落。
 */
import type { ReactNode } from 'react';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // **bold** / `code` / 普通文本
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`c-${key++}`}>{token.slice(1, -1)}</code>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function AiMarkdown({ content }: { content: string }) {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.trim()) return null;

  const blocks: ReactNode[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let blockKey = 0;

  const pushProse = (chunk: string) => {
    const lines = chunk.split('\n');
    let listItems: string[] = [];
    const flushList = () => {
      if (listItems.length === 0) return;
      blocks.push(
        <ul key={`ul-${blockKey++}`} className="ai-md-list">
          {listItems.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      listItems = [];
    };

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.trim()) {
        flushList();
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flushList();
        const level = heading[1].length;
        const Tag = (level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6') as 'h4' | 'h5' | 'h6';
        blocks.push(
          <Tag key={`h-${blockKey++}`} className="ai-md-heading">
            {renderInline(heading[2])}
          </Tag>,
        );
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        listItems.push(bullet[1]);
        continue;
      }
      flushList();
      blocks.push(
        <p key={`p-${blockKey++}`} className="ai-md-p">
          {renderInline(trimmed)}
        </p>,
      );
    }
    flushList();
  };

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) pushProse(text.slice(cursor, match.index));
    const lang = (match[1] || '').trim();
    const code = match[2].replace(/\n$/, '');
    blocks.push(
      <pre key={`pre-${blockKey++}`} className="ai-md-code" data-lang={lang || undefined}>
        <code dangerouslySetInnerHTML={{ __html: escapeHtml(code) }} />
      </pre>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushProse(text.slice(cursor));

  return <div className="ai-markdown">{blocks}</div>;
}