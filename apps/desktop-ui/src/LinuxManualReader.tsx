import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Copy, X } from 'lucide-react';
import { writeClipboardText } from './api';
import {
  createLinuxManualHeadingSlugger, linuxManualIndex, loadLinuxManualDocument,
  openLinuxManualExternalUrl, resolveLinuxManualLink, safeLinuxManualExternalUrl,
} from './linuxManualModel';
import './LinuxManual.css';

export type LinuxManualReaderProps = {
  selectedId: string;
  onSelect: (id: string, hash?: string) => void;
  onClose: () => void;
  visible?: boolean;
  hash?: string;
};

type MarkdownTreeNode = {
  type: string;
  value?: string;
  children?: MarkdownTreeNode[];
  data?: { hProperties?: Record<string, unknown> };
};
function treeText(node: MarkdownTreeNode): string {
  return node.value ?? node.children?.map(treeText).join('') ?? '';
}
function manualHeadingAnchors() {
  return (tree: MarkdownTreeNode) => {
    const slug = createLinuxManualHeadingSlugger();
    function visit(node: MarkdownTreeNode) {
      if (node.type === 'heading') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug(treeText(node)) } };
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
function reactText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? reactText(child.props.children) : '';
  }).join('');
}

function ManualCodeBlock({ children }: { children?: ReactNode }) {
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function copy() {
    try {
      await writeClipboardText(reactText(children));
      if (mounted.current) setMessage('已复制');
    } catch {
      if (mounted.current) setMessage('复制失败，请重试');
    }
  }
  return <div className="linux-manual-code-block">
    <div className="linux-manual-code-toolbar"><span role="status">{message}</span><button type="button" aria-label="复制代码" onClick={() => void copy()}><Copy size={13} aria-hidden="true" />复制</button></div>
    <pre>{children}</pre>
  </div>;
}

export type LinuxManualMarkdownProps = {
  markdown: string;
  onSelect: (id: string, hash?: string) => void;
  onHash: (hash: string) => void;
  onExternalError?: () => void;
};

/** Exported separately to make Markdown safety and formatting testable without async document loading. */
export function LinuxManualMarkdown({ markdown, onSelect, onHash, onExternalError }: LinuxManualMarkdownProps) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, manualHeadingAnchors]} skipHtml components={{
    pre: ({ children }) => <ManualCodeBlock>{children}</ManualCodeBlock>,
    a: ({ href, children }) => {
      const link = resolveLinuxManualLink(href ?? '');
      if (link.kind === 'blocked') return <span className="linux-manual-blocked-link">{children}</span>;
      return <a href={href} rel={link.kind === 'external' ? 'noopener noreferrer' : undefined} onClick={(event) => {
        event.preventDefault();
        if (link.kind === 'hash') onHash(link.hash);
        else if (link.kind === 'command') onSelect(link.id, link.hash);
        else {
          void openLinuxManualExternalUrl(link.url).catch(() => onExternalError?.());
        }
      }}>{children}</a>;
    },
    img: ({ src, alt }) => {
      const url = safeLinuxManualExternalUrl(src ?? '');
      return <span className="linux-manual-illustration">[插图：{alt || '图片'}{url && <> · <a href={url} rel="noopener noreferrer" onClick={(event) => {
        event.preventDefault();
        void openLinuxManualExternalUrl(url).catch(() => onExternalError?.());
      }}>打开原图</a></>}]</span>;
    },
  }}>{markdown}</ReactMarkdown>;
}

type DocumentState = { id: string; status: 'loading' | 'ready' | 'error'; markdown?: string; error?: string };

export function LinuxManualReader({ selectedId, onSelect, onClose, visible = true, hash }: LinuxManualReaderProps) {
  const [document, setDocument] = useState<DocumentState>({ id: selectedId, status: 'loading' });
  const [retry, setRetry] = useState(0);
  const [linkError, setLinkError] = useState('');
  const [localAnchor, setLocalAnchor] = useState<{ id: string; hash: string; sequence: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<{ id: string; hash: string } | null>(null);
  const entry = linuxManualIndex.find((item) => item.id === selectedId);
  const current = document.id === selectedId ? document : { id: selectedId, status: 'loading' as const };

  useEffect(() => {
    let cancelled = false;
    setDocument({ id: selectedId, status: 'loading' });
    setLinkError('');
    loadLinuxManualDocument(selectedId).then((markdown) => {
      if (!cancelled) setDocument({ id: selectedId, status: 'ready', markdown });
    }, (error: unknown) => {
      if (!cancelled) setDocument({ id: selectedId, status: 'error', error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [selectedId, retry]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const pending = pendingAnchor.current;
    setLocalAnchor(pending?.id === selectedId ? { ...pending, sequence: 0 } : null);
    pendingAnchor.current = null;
  }, [selectedId]);
  useEffect(() => { setLocalAnchor(null); }, [hash]);
  useEffect(() => {
    if (!visible || current.status !== 'ready') return;
    const targetHash = localAnchor?.id === selectedId ? localAnchor.hash : hash;
    if (!targetHash) return;
    const heading = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find((node) => node.id === targetHash);
    heading?.scrollIntoView({ block: 'start' });
  }, [selectedId, current.status, hash, localAnchor, visible]);

  function navigate(id: string, anchor?: string) {
    if (id !== selectedId) pendingAnchor.current = { id, hash: anchor ?? '' };
    setLocalAnchor((previous) => ({ id, hash: anchor ?? '', sequence: (previous?.sequence ?? 0) + 1 }));
    if (id === selectedId && !anchor && scrollRef.current) scrollRef.current.scrollTop = 0;
    onSelect(id, anchor);
  }

  return <section className="linux-manual-reader" aria-label="Linux 命令文档" hidden={!visible}>
    <header className="linux-manual-reader-header">
      <BookOpen size={17} aria-hidden="true" /><h2>{entry?.name ?? selectedId}</h2><span>Linux 命令手册</span>
      <button type="button" aria-label="关闭 Linux 命令手册" title="关闭" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="linux-manual-reader-scroll" ref={scrollRef}>
      {linkError && <p className="linux-manual-notice" role="alert">{linkError}</p>}
      {current.status === 'loading' && <p className="linux-manual-state" role="status">正在加载命令文档…</p>}
      {current.status === 'error' && <div className="linux-manual-state" role="alert"><p>{current.error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
      {current.status === 'ready' && <article className="linux-manual-markdown" key={selectedId}>
        <LinuxManualMarkdown markdown={current.markdown ?? ''} onSelect={navigate} onHash={(anchor) => setLocalAnchor((previous) => ({ id: selectedId, hash: anchor, sequence: (previous?.sequence ?? 0) + 1 }))} onExternalError={() => setLinkError('无法打开链接，请重试')} />
      </article>}
    </div>
  </section>;
}

export default LinuxManualReader;
