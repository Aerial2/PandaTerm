import { useRef, useState, type RefObject } from 'react';
import { readFileAsDataUrl } from './api';
import { setStatusMessage } from './appShellStore';
import type { ResourceFile } from './resourceModel';
import type { WorkspaceTab } from './terminalLayout';

export type MediaKind = 'image' | 'video' | 'audio';

type MediaViewerState = { url: string; name: string; kind: MediaKind };

export type MediaOpenTarget = {
  paneId: string | null;
  terminalId: string | null;
  session: WorkspaceTab['session'] | null;
};

interface UseMediaViewerParams {
  activePaneTabRef: RefObject<WorkspaceTab | null>;
  isLocalResourceTab: (tab: WorkspaceTab | null) => boolean;
  onOpened?: (file: ResourceFile, kind: MediaKind, target: MediaOpenTarget) => void | Promise<void>;
}

// 媒体预览域：图片/视频/音频的内联查看器，按 generation 防止切换 pane 后旧请求串扰。
export function useMediaViewer({ activePaneTabRef, isLocalResourceTab, onOpened }: UseMediaViewerParams) {
  const [mediaViewer, setMediaViewer] = useState<MediaViewerState | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const mediaLoadGenerationRef = useRef(0);

  // 关闭预览时也使进行中的读取失效。
  function closeMediaViewer() {
    resetMediaViewer();
  }

  // 硬重置：使进行中的请求失效并停止 loading，用于切换 pane。
  function resetMediaViewer() {
    mediaLoadGenerationRef.current += 1;
    setIsLoadingMedia(false);
    setMediaViewer(null);
    setMediaError('');
  }

  async function openMediaViewer(file: ResourceFile, kind: MediaKind, explicitTarget?: MediaOpenTarget) {
    let generation = mediaLoadGenerationRef.current;
    const tab = activePaneTabRef.current;
    const target: MediaOpenTarget = explicitTarget ?? {
      paneId: tab?.id ?? null,
      terminalId: isLocalResourceTab(tab) ? null : tab?.terminalId ?? null,
      session: isLocalResourceTab(tab) ? null : tab?.session ?? null,
    };
    const paneId = target.paneId;
    const terminalId = target.terminalId;
    const initialTab = tab;
    const isCurrentTarget = () => {
      const currentTab = activePaneTabRef.current;
      const currentTerminalId = isLocalResourceTab(currentTab) ? null : currentTab?.terminalId ?? null;
      const connected = isLocalResourceTab(currentTab) || currentTab?.status === 'connected';
      return generation === mediaLoadGenerationRef.current
        && paneId === (currentTab?.id ?? null)
        && terminalId === currentTerminalId
        && (target.session?.id ?? null) === (isLocalResourceTab(currentTab) ? null : currentTab?.session?.id ?? null)
        && (isLocalResourceTab(currentTab) || (terminalId !== null && connected));
    };
    if (!isCurrentTarget()) {
      if (!explicitTarget && !isLocalResourceTab(initialTab) && initialTab?.status !== 'connected') {
        setMediaError('远程终端尚未连接，无法查看媒体文件');
        setStatusMessage('远程终端尚未连接，无法查看媒体文件');
      }
      return;
    }
    generation = ++mediaLoadGenerationRef.current;
    setMediaViewer(null);
    setMediaError('');
    setIsLoadingMedia(true);
    try {
      const url = await readFileAsDataUrl(file.path, terminalId);
      if (!isCurrentTarget()) return;
      setMediaViewer({ url, name: file.name, kind });
      setStatusMessage(`正在查看：${file.name}`);
      void onOpened?.(file, kind, target);
    } catch (error) {
      if (!isCurrentTarget()) return;
      const message = error instanceof Error ? error.message : String(error);
      setMediaError(message);
      setStatusMessage(`无法查看媒体文件：${message}`);
    } finally {
      if (isCurrentTarget()) setIsLoadingMedia(false);
    }
  }

  return {
    mediaViewer,
    isLoadingMedia,
    mediaError,
    openMediaViewer,
    closeMediaViewer,
    resetMediaViewer,
  };
}