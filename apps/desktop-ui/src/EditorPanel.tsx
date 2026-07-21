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
  loadProgress?: {
    transferred: number;
    total: number;
    speed: number;
  };
  error: string;
  isUntitled?: boolean;
};

export type EditorPanelProps = {
  tabs: EditorTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSave: (id: string) => void;
  onContentChange: (id: string, content: string) => void;
  onCreateUntitled: () => void;
  /** false：tabs 由外层统一 tab 栏托管，此处只渲染保存条 + 正文 */
  showTabBar?: boolean;
  /** 隐藏时仍可保持挂载；用于切终端后恢复滚动/光标 */
  visible?: boolean;
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

/** 每个 tab 的滚动/光标/选区（跨终端切换、跨 panel 隐藏） */
const editorViewStateByTabId = new Map<string, monaco.editor.ICodeEditorViewState>();

function formatLoadingBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tabModelUri(tabId: string): monaco.Uri {
  return monaco.Uri.parse(`pandaterm-tab:///${encodeURIComponent(tabId)}`);
}

function saveEditorViewState(
  editor: monaco.editor.IStandaloneCodeEditor | null | undefined,
  tabId: string | null | undefined,
): void {
  if (!editor || !tabId) return;
  try {
    const state = editor.saveViewState();
    if (state) editorViewStateByTabId.set(tabId, state);
  } catch {
    // editor 已 dispose 时忽略
  }
}

function restoreEditorViewState(
  editor: monaco.editor.IStandaloneCodeEditor | null | undefined,
  tabId: string | null | undefined,
): void {
  if (!editor || !tabId) return;
  const state = editorViewStateByTabId.get(tabId);
  if (!state) return;
  try {
    editor.restoreViewState(state);
  } catch {
    // ignore
  }
}

export function EditorPanel({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onSave,
  onContentChange,
  onCreateUntitled,
  showTabBar = true,
  visible = true,
  theme,
}: EditorPanelProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  /** 当前编辑器上附着的 tab（用于切换时保存旧 tab 视口） */
  const boundTabIdRef = useRef<string | null>(null);
  const suppressModelEventRef = useRef(false);
  const saveHandlersRef = useRef<Map<string, () => void>>(new Map());
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const ensureModel = useCallback((tab: EditorTab): monaco.editor.ITextModel => {
    const existing = modelsRef.current.get(tab.id);
    if (existing && !existing.isDisposed()) {
      // 已有 model 以编辑器内文本为准，不在这里 setValue（避免切 tab 时冲掉视口）
      if (existing.getLanguageId() !== tab.language) {
        monaco.editor.setModelLanguage(existing, tab.language);
      }
      return existing;
    }
    const uri = tabModelUri(tab.id);
    const stale = monaco.editor.getModel(uri);
    if (stale && !stale.isDisposed()) stale.dispose();
    const model = monaco.editor.createModel(tab.content, tab.language, uri);
    modelsRef.current.set(tab.id, model);
    return model;
  }, []);

  /** 切到指定 tab：先存旧视口 → setModel → 恢复新视口（不依赖 content，避免输入时反复 restore） */
  const bindTabToEditor = useCallback((tab: EditorTab | null) => {
    const editor = editorRef.current;
    if (!editor) return;

    const prevId = boundTabIdRef.current;
    if (prevId && prevId !== tab?.id) {
      saveEditorViewState(editor, prevId);
    }

    if (!tab || tab.error) {
      if (tab?.error) {
        editor.setModel(null);
        boundTabIdRef.current = null;
      }
      return;
    }

    if (tab.loading) {
      // 加载中不展示其它 tab 内容
      if (prevId && prevId !== tab.id) {
        saveEditorViewState(editor, prevId);
        editor.setModel(null);
        boundTabIdRef.current = null;
      }
      return;
    }

    const model = ensureModel(tab);
    const needSwitch = editor.getModel() !== model || prevId !== tab.id;
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    boundTabIdRef.current = tab.id;
    if (needSwitch) {
      // 双 rAF：等 Monaco 完成 model 附着与布局后再 restore
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (editor.getModel() !== model) return;
          restoreEditorViewState(editor, tab.id);
          editor.layout();
        });
      });
    }
  }, [ensureModel]);

  const handleBeforeMount: BeforeMount = useCallback((monacoApi) => {
    monacoApi.editor.defineTheme(DARK_THEME, {
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

  const handleMount: OnMount = useCallback((editor, monacoApi) => {
    editorRef.current = editor;
    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      const handler = saveHandlersRef.current.get(activeTabIdRef.current ?? '');
      if (handler) handler();
    });
    editor.onDidChangeModelContent(() => {
      if (suppressModelEventRef.current) return;
      const tabId = boundTabIdRef.current;
      if (!tabId) return;
      onContentChangeRef.current(tabId, editor.getValue());
    });
    // 滚动/光标变化时持续落盘，切换 tab 前即使异常卸载也能恢复
    editor.onDidScrollChange(() => {
      saveEditorViewState(editor, boundTabIdRef.current);
    });
    editor.onDidChangeCursorPosition(() => {
      saveEditorViewState(editor, boundTabIdRef.current);
    });

    const tab = tabsRef.current.find((item) => item.id === activeTabIdRef.current) ?? null;
    if (tab && !tab.loading && !tab.error) {
      const model = ensureModel(tab);
      editor.setModel(model);
      boundTabIdRef.current = tab.id;
      requestAnimationFrame(() => {
        restoreEditorViewState(editor, tab.id);
      });
    }
  }, [ensureModel]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeLoadProgress = activeTab?.loadProgress;
  const activeLoadPercent = activeLoadProgress && activeLoadProgress.total > 0
    ? Math.min(100, Math.round((activeLoadProgress.transferred / activeLoadProgress.total) * 100))
    : null;

  useEffect(() => {
    if (!activeTab) return;
    saveHandlersRef.current.set(activeTab.id, () => onSave(activeTab.id));
    return () => { saveHandlersRef.current.delete(activeTab.id); };
  }, [activeTab, onSave]);

  // tab 切换 / 加载结束 → 绑定 model 并恢复该 tab 视口
  useEffect(() => {
    const tab = tabsRef.current.find((item) => item.id === activeTabId) ?? null;
    bindTabToEditor(tab);
  }, [activeTabId, activeTab?.loading, activeTab?.error, bindTabToEditor]);

  // 外部写入 content（如远程读完）同步进 model，尽量保留当前视口
  useEffect(() => {
    if (!activeTab || activeTab.loading || activeTab.error) return;
    const model = modelsRef.current.get(activeTab.id);
    if (!model || model.isDisposed()) {
      bindTabToEditor(activeTab);
      return;
    }
    if (model.getLanguageId() !== activeTab.language) {
      monaco.editor.setModelLanguage(model, activeTab.language);
    }
    if (model.getValue() === activeTab.content) return;

    const editor = editorRef.current;
    const keepView = editor?.getModel() === model ? editor.saveViewState() : null;
    suppressModelEventRef.current = true;
    model.setValue(activeTab.content);
    suppressModelEventRef.current = false;
    if (keepView && editor) {
      requestAnimationFrame(() => editor.restoreViewState(keepView));
    }
  }, [activeTabId, activeTab?.content, activeTab?.language, activeTab?.loading, activeTab?.error, activeTab, bindTabToEditor]);

  // 隐藏面板：保存视口；再显示 layout + 恢复
  useEffect(() => {
    const editor = editorRef.current;
    const tabId = boundTabIdRef.current ?? activeTabIdRef.current;
    if (!visible) {
      saveEditorViewState(editor, tabId);
      return;
    }
    const frame = requestAnimationFrame(() => {
      editor?.layout();
      restoreEditorViewState(editor, tabId);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  // 关闭的 tab：释放 model + viewState
  useEffect(() => {
    const alive = new Set(tabs.map((t) => t.id));
    for (const [id, model] of [...modelsRef.current.entries()]) {
      if (alive.has(id)) continue;
      if (!model.isDisposed()) model.dispose();
      modelsRef.current.delete(id);
      editorViewStateByTabId.delete(id);
      if (boundTabIdRef.current === id) boundTabIdRef.current = null;
    }
  }, [tabs]);

  // 卸载：保存视口、不销毁全局 viewState（同会话可能再挂载）
  useEffect(() => () => {
    saveEditorViewState(editorRef.current, boundTabIdRef.current ?? activeTabIdRef.current);
  }, []);

  const nameCounts = new Map<string, number>();
  for (const t of tabs) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);

  function tabLabel(tab: EditorTab): string {
    if ((nameCounts.get(tab.name) ?? 0) > 1) {
      const parts = tab.path.split('/');
      const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
      return parent ? `${tab.name} (${parent})` : tab.name;
    }
    return tab.name;
  }

  const saveButton = activeTab ? (
    <button
      className="editor-save-btn"
      title={activeTab.isUntitled ? '未命名文件需先指定保存路径' : '保存 (Ctrl+S)'}
      disabled={activeTab.isUntitled || activeTab.content === activeTab.originalContent || activeTab.loading}
      onClick={() => onSave(activeTab.id)}
    >
      <Save size={15} />
    </button>
  ) : null;

  const showEditorSurface = Boolean(activeTab && !activeTab.error);
  const showLoadingOverlay = Boolean(activeTab?.loading);

  return (
    <div className={`editor-panel${showTabBar ? '' : ' editor-panel-embedded'}`}>
      {showTabBar ? (
        <div className="editor-tabs-bar">
          <div
            className="editor-tabs"
            title="双击空白处新建空白文件"
            onWheel={(event) => {
              const el = event.currentTarget;
              if (el.scrollWidth <= el.clientWidth) return;
              const delta =
                Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
              if (delta === 0) return;
              const max = el.scrollWidth - el.clientWidth;
              const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
              if (next === el.scrollLeft) return;
              event.preventDefault();
              el.scrollLeft = next;
            }}
            onDoubleClick={(event) => {
              if (event.target === event.currentTarget) onCreateUntitled();
            }}
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === activeTabId ? 'editor-tab active' : 'editor-tab'}
                onClick={() => onSelectTab(tab.id)}
                title={tab.isUntitled ? '未保存的空白文件' : tab.path}
              >
                <FileText size={13} />
                <span className="editor-tab-name">{tabLabel(tab)}</span>
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
          {saveButton}
        </div>
      ) : activeTab ? (
        <div className="editor-embedded-toolbar">
          <span className="editor-embedded-path" title={activeTab.isUntitled ? '未保存的空白文件' : activeTab.path}>
            {activeTab.isUntitled ? activeTab.name : activeTab.path || activeTab.name}
          </span>
          {saveButton}
        </div>
      ) : null}
      <div className="editor-body">
        {activeTab?.error ? (
          <div className="editor-error">
            <h3>无法打开文件</h3>
            <p>{activeTab.error}</p>
          </div>
        ) : showEditorSurface ? (
          <>
            {showLoadingOverlay && (
              <div className="editor-loading editor-loading-overlay">
                <div>正在加载文件...</div>
                {activeLoadProgress && activeLoadPercent !== null && (
                  <div className="editor-load-progress" aria-label={`文件加载进度 ${activeLoadPercent}%`}>
                    <div className="editor-load-progress-track">
                      <div className="editor-load-progress-fill" style={{ width: `${activeLoadPercent}%` }} />
                    </div>
                    <div className="editor-load-progress-meta">
                      <span>{activeLoadPercent}%</span>
                      <span>
                        {formatLoadingBytes(activeLoadProgress.transferred)} / {formatLoadingBytes(activeLoadProgress.total)}
                      </span>
                      {activeLoadProgress.speed > 0 && (
                        <span>{formatLoadingBytes(activeLoadProgress.speed)}/s</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* 不设 key：单实例 + 多 model，切换 tab 保留各自滚动位置 */}
            <Editor
              theme={theme ?? DARK_THEME}
              beforeMount={handleBeforeMount}
              onMount={handleMount}
              defaultLanguage="plaintext"
              defaultValue=""
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
          </>
        ) : (
          <div className="editor-empty">双击标签栏空白处新建空白文件</div>
        )}
      </div>
    </div>
  );
}