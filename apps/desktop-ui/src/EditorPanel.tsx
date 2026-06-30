import { useCallback, useEffect, useRef } from 'react';
import Editor, { loader, type OnMount, type BeforeMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { X, Save, Circle, FileText } from 'lucide-react';

// Use locally bundled monaco-editor (no CDN dependency) and wire up the Vite
// worker so syntax highlighting works offline inside Tauri.
(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

export type EditorTab = {
  id: string;
  path: string;
  name: string;
  language: string;
  content: string;
  originalContent: string;
  isRemote: boolean;
  terminalId?: string;
  loading: boolean;
  error: string;
};

export type EditorPanelProps = {
  tabs: EditorTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSave: (id: string) => void;
  onContentChange: (id: string, content: string) => void;
  theme?: string;
};

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', rs: 'rust', py: 'python', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml',
    xml: 'xml', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    vue: 'html', svelte: 'html', php: 'php', rb: 'ruby', kt: 'kotlin',
    swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', pl: 'perl',
    txt: 'plaintext', log: 'plaintext', env: 'ini',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return map[ext] ?? 'plaintext';
}

export { detectLanguage };

const DARK_THEME = 'pandaterm-dark';

export function EditorPanel({ tabs, activeTabId, onSelectTab, onCloseTab, onSave, onContentChange, theme }: EditorPanelProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const saveHandlersRef = useRef<Map<string, () => void>>(new Map());

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme(DARK_THEME, {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c678dd' },
        { token: 'string', foreground: '98c379' },
        { token: 'number', foreground: 'd19a66' },
        { token: 'type', foreground: '61afef' },
        { token: 'function', foreground: '61afef' },
        { token: 'variable', foreground: 'e06c75' },
      ],
      colors: {
        'editor.background': '#23272e',
        'editor.foreground': '#e6e6e6',
        'editorLineNumber.foreground': '#495162',
        'editorLineNumber.activeForeground': '#abb2bf',
        'editor.selectionBackground': '#3d4450',
        'editor.lineHighlightBackground': '#2c313a',
        'editorCursor.foreground': '#61afef',
        'editorWhitespace.foreground': '#3b4048',
        'editorIndentGuide.background': '#3b4048',
        'editorIndentGuide.activeBackground': '#5c6370',
        'editorGutter.background': '#23272e',
        'editorBracketMatch.background': '#3d4450',
        'editorWidget.background': '#282c34',
        'editorWidget.border': '#181a1f',
        'editorSuggestWidget.background': '#282c34',
        'editorSuggestWidget.selectedBackground': '#2c313a',
        'editorSuggestWidget.highlightForeground': '#61afef',
        'scrollbarSlider.background': '#4b526388',
        'scrollbarSlider.hoverBackground': '#4b5263aa',
        'scrollbarSlider.activeBackground': '#4b5263cc',
      },
    });
  }, []);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const handler = saveHandlersRef.current.get(activeTabId ?? '');
      if (handler) handler();
    });
  }, [activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Register save handler for the active tab so Ctrl+S works.
  useEffect(() => {
    if (!activeTab) return;
    saveHandlersRef.current.set(activeTab.id, () => onSave(activeTab.id));
    return () => { saveHandlersRef.current.delete(activeTab.id); };
  }, [activeTab, onSave]);

  if (tabs.length === 0) return null;

  return (
    <div className="editor-panel">
      <div className="editor-tabs-bar">
        <div className="editor-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeTabId ? 'editor-tab active' : 'editor-tab'}
              onClick={() => onSelectTab(tab.id)}
            >
              <FileText size={13} />
              <span className="editor-tab-name">{tab.name}</span>
              {tab.content !== tab.originalContent && (
                <Circle size={8} className="editor-tab-dirty" fill="currentColor" />
              )}
              <button
                className="editor-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                title="关闭"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        {activeTab && (
          <button
            className="editor-save-btn"
            title="保存 (Ctrl+S)"
            disabled={activeTab.content === activeTab.originalContent || activeTab.loading}
            onClick={() => onSave(activeTab.id)}
          >
            <Save size={15} />
          </button>
        )}
      </div>
      <div className="editor-body">
        {activeTab?.loading ? (
          <div className="editor-loading">正在加载文件...</div>
        ) : activeTab?.error ? (
          <div className="editor-error">
            <h3>无法打开文件</h3>
            <p>{activeTab.error}</p>
          </div>
        ) : activeTab ? (
          <Editor
            key={activeTab.id}
            theme={theme ?? DARK_THEME}
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            language={activeTab.language}
            value={activeTab.content}
            onChange={(value) => {
              if (value !== undefined && activeTab) {
                onContentChange(activeTab.id, value);
              }
            }}
            options={{
              fontSize: 14,
              fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, Monaco, monospace',
              fontLigatures: true,
              minimap: { enabled: true, scale: 1 },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderWhitespace: 'selection',
              renderLineHighlight: 'all',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 12 },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              stickyScroll: { enabled: true },
            }}
          />
        ) : (
          <div className="editor-empty">选择一个文件进行编辑</div>
        )}
      </div>
    </div>
  );
}
