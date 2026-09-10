import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import {
  getLocalTerminalProfile,
  readClipboardText,
  resizeLocalTerminal,
  sendLocalTerminalInput,
  startLocalTerminal,
  stopLocalTerminal,
  writeClipboardText,
  type TerminalOutputEvent,
  type TerminalStatusEvent,
} from './api';
import { prepareTerminalPaste } from './terminalPaste';

const terminalTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#61afef',
  selectionBackground: 'rgba(97, 175, 239, 0.15)',
  black: '#23272e',
  blue: '#61afef',
  cyan: '#56b6c2',
  green: '#98c379',
  magenta: '#c678dd',
  red: '#e06c75',
  white: '#e6e6e6',
  yellow: '#e5c07b',
  brightBlack: '#6c7086',
  brightBlue: '#61afef',
  brightCyan: '#56b6c2',
  brightGreen: '#98c379',
  brightMagenta: '#c678dd',
  brightRed: '#e06c75',
  brightWhite: '#e6e6e6',
  brightYellow: '#e5c07b',
};

type LocalTerminalViewProps = {
  /** 面板可见时 fit + focus；隐藏时保持 PTY 存活 */
  active: boolean;
};

/**
 * 底部面板专用本地终端：自管 xterm / PTY，不进入工作区 tab。
 */
export function LocalTerminalView({ active }: LocalTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string>('');
  const pendingOutputRef = useRef<string[]>([]);
  const startedRef = useRef(false);
  const startingRef = useRef(false);

  function fitIfNeeded() {
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    const host = hostRef.current;
    if (!terminal || !fitAddon || !host) return;
    if (host.clientWidth < 20 || host.clientHeight < 20) return;
    try {
      fitAddon.fit();
      const id = terminalIdRef.current;
      if (id) {
        void resizeLocalTerminal(id, terminal.cols, terminal.rows).catch(() => {});
      }
    } catch {
      // fit 在隐藏布局上可能失败，忽略
    }
  }

  // 初始化 xterm（一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || terminalRef.current) return;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, Monaco, monospace',
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1,
      scrollback: 5000,
      theme: terminalTheme,
    });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.altKey) return true;
      const key = event.key.toLowerCase();
      const isCopy =
        event.ctrlKey && (event.code === 'KeyC' || key === 'c' || event.code === 'Insert');
      const isPaste =
        (event.ctrlKey && (event.code === 'KeyV' || key === 'v')) ||
        (event.shiftKey && event.code === 'Insert');

      if (isCopy) {
        if (event.type !== 'keydown') return false;
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          event.stopPropagation();
          void writeClipboardText(selection).catch(() => {});
          return false;
        }
        return event.code === 'KeyC' && !event.shiftKey;
      }

      if (isPaste) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) {
          void (async () => {
            try {
              const raw = await readClipboardText();
              const id = terminalIdRef.current;
              if (!raw || !id) return;
              // 与远端 SSH 粘贴保持一致：超长截断 + 危险控制字符/多行提示，
              // 避免把含 ESC 等控制序列的剪贴板直接灌进本地 shell
              const prepared = prepareTerminalPaste(raw);
              if (prepared.requiresConfirmation
                && !window.confirm('剪贴板内容包含控制字符或多行命令，粘贴到本地终端可能触发意外行为。确定粘贴吗？')) {
                return;
              }
              await sendLocalTerminalInput(id, prepared.text);
            } catch {
              // ignore
            }
          })();
        }
        return false;
      }

      return true;
    });

    const dataDisposable = terminal.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void sendLocalTerminalInput(id, data).catch(() => {});
    });

    const resizeObserver = new ResizeObserver(() => {
      fitIfNeeded();
    });
    resizeObserver.observe(host);

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      const id = terminalIdRef.current;
      if (id) {
        void stopLocalTerminal(id).catch(() => {});
        terminalIdRef.current = '';
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      startedRef.current = false;
      startingRef.current = false;
    };
  }, []);

  // 输出 / 状态事件
  useEffect(() => {
    let disposed = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;

    void listen<TerminalOutputEvent>('terminal-output', (event) => {
      if (disposed) return;
      const { terminal_id, payload } = event.payload;
      if (!payload) return;
      if (terminal_id !== terminalIdRef.current) {
        // 启动竞态：terminal_id 尚未写入时先缓存
        if (!terminalIdRef.current && startingRef.current) {
          pendingOutputRef.current.push(payload);
        }
        return;
      }
      terminalRef.current?.write(payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutput = fn;
    });

    void listen<TerminalStatusEvent>('terminal-status', (event) => {
      if (disposed) return;
      const status = event.payload;
      if (status.terminal_id !== terminalIdRef.current) return;
      if (status.state === 'failed' && status.reason) {
        terminalRef.current?.writeln(`\r\n\x1b[31m本地终端错误：${status.reason}\x1b[0m`);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenStatus = fn;
    });

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenStatus?.();
    };
  }, []);

  // 首次可见时启动 PTY；每次 active 时 fit + focus
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const run = async () => {
      requestAnimationFrame(() => {
        fitIfNeeded();
        if (active) terminalRef.current?.focus();
      });

      if (startedRef.current || startingRef.current || terminalIdRef.current) {
        return;
      }
      startingRef.current = true;
      try {
        const profileMeta = await getLocalTerminalProfile().catch(() => null);
        const cwd = profileMeta?.cwd || null;
        const terminal = terminalRef.current;
        if (!terminal || cancelled) return;
        fitIfNeeded();
        const profile = await startLocalTerminal(cwd, terminal.cols, terminal.rows);
        if (cancelled) {
          void stopLocalTerminal(profile.terminal_id).catch(() => {});
          return;
        }
        terminalIdRef.current = profile.terminal_id;
        startedRef.current = true;
        for (const chunk of pendingOutputRef.current) {
          terminal.write(chunk);
        }
        pendingOutputRef.current = [];
        requestAnimationFrame(() => {
          fitIfNeeded();
          terminal.focus();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminalRef.current?.writeln(`\r\n\x1b[31m本地终端启动失败：${message}\x1b[0m`);
      } finally {
        startingRef.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [active]);

  return <div className="resource-local-terminal-host" ref={hostRef} />;
}