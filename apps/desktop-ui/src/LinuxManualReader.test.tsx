import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LinuxManualMarkdown, LinuxManualReader } from './LinuxManualReader';
import { LinuxManualPanel } from './LinuxManualPanel';

vi.mock('./api', () => ({ writeClipboardText: vi.fn().mockResolvedValue(undefined) }));

function render(markdown: string) {
  return renderToStaticMarkup(<LinuxManualMarkdown markdown={markdown} onSelect={vi.fn()} onHash={vi.fn()} />);
}

describe('Linux manual Markdown rendering', () => {
  it('renders GFM tables, task lists, strikethrough and code copy controls', () => {
    const html = render('| 命令 | 用途 |\n| --- | --- |\n| ls | 列出文件 |\n\n- [x] 已完成\n\n~~旧参数~~\n\n```sh\nls -la\n```');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>旧参数</del>');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('class="language-sh"');
    expect(html).toContain('ls -la');
  });
  it('adds stable heading IDs including duplicate titles and Chinese anchors', () => {
    const html = render('# ls\n\n## 实例\n\n## 实例\n\n## **Options** and `flags`\n\n[示例](#%E5%AE%9E%E4%BE%8B)');
    expect(html).toContain('id="ls"');
    expect(html).toContain('id="实例"');
    expect(html).toContain('id="实例-1"');
    expect(html).toContain('id="options-and-flags"');
    expect(html).toContain('href="#%E5%AE%9E%E4%BE%8B"');
  });
  it('omits raw HTML and unsafe link targets', () => {
    const html = render('<script>alert("unsafe")</script>\n\n<iframe src="https://tracker.example"></iframe>\n\n[危险](javascript:alert%281%29)\n\n[文件](file:///etc/passwd)\n\n[缺失](missing-command.md)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('file:');
    expect(html).not.toContain('href=');
    expect(html).toContain('危险');
  });
  it('renders remote images only as explicit links without fetching images', () => {
    const html = render('![插图说明](https://tracker.example/image.png)\n\n![本地](./image.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('rel="preload"');
    expect(html).toContain('插图说明');
    expect(html).toContain('打开原图');
    expect(html).toContain('href="https://tracker.example/image.png"');
    expect(html).not.toContain('href="./image.png"');
  });
  it('preserves bundled command links and safe source attribution links', () => {
    const html = render('[ls](ls.md#实例)\n\n[来源](https://github.com/jaywcjlove/linux-command)');
    expect(html).toContain('href="ls.md#%E5%AE%9E%E4%BE%8B"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('Linux manual controlled components', () => {
  it('retains a controlled query and selected command in the sidebar', () => {
    const html = renderToStaticMarkup(<LinuxManualPanel query=" LS " setQuery={vi.fn()} selectedId="ls" onSelect={vi.fn()} />);
    expect(html).toContain('value=" LS "');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('搜索命令名称或中文描述');
  });
  it('marks invisible panes hidden and renders accessible loading controls', () => {
    const html = renderToStaticMarkup(<LinuxManualReader selectedId="ls" onSelect={vi.fn()} onClose={vi.fn()} visible={false} />);
    expect(html).toContain('hidden=""');
    expect(html).toContain('role="status"');
    expect(html).toContain('正在加载命令文档');
    expect(html).toContain('关闭 Linux 命令手册');
  });
});
