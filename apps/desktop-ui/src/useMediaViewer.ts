import { useRef, useState, type RefObject } from 'react';
import { readFileAsDataUrl } from './api';
import { setStatusMessage } from './appShellStore';
import type { ResourceFile } from './resourceModel';
import type { WorkspaceTab } from './terminalLayout';

export type MediaKind = 'image' | 'video' | 'audio';

type MediaViewerState = { url: string; name: string; kind: MediaKind };

interface UseMediaViewerParams {
  // 当前工作区 pane（读 ref 保证异步回调拿到实时目标，而非闭包旧值）
  activePaneTabRef: RefObject<WorkspaceTab | null>;
  // 由 App 注入：判断 pane 是本地还是远程终端
  isLocalResourceTab: (tab: WorkspaceTab | null) => boolean;
}

// 媒体预览域：图片/视频/音频的内联查看器，按 generation 防止切换 pane 后旧请求串扰。
export function useMediaViewer({ activePaneTabRef, isLocalResourceTab }: UseMediaViewerParams) {
  const [mediaViewer, setMediaViewer] = useState<MediaViewerState | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const mediaLoadGenerationRef = useRef(0);

  // 软重置：清空预览与错误，用于目录加载成功后（不打断进行中的请求计数）。
  function closeMediaViewer() {
    setMediaViewer(null);
    setMediaError('');
  }

  // 硬重置：使进行中的请求失效并停止 loading，用于切换 pane。
  function resetMediaViewer() {
    mediaLoadGenerationRef.current += 1;
    setIsLoadingMedia(false);
    setMediaViewer(null);
    setMediaError('');
  }

  async function openMediaViewer(file: ResourceFile, kind: MediaKind) {
    const generation = ++mediaLoadGenerationRef.current;
    const tab = activePaneTabRef.current;
    const paneId = tab?.id ?? null;
    const terminalId = isLocalResourceTab(tab) ? null : tab?.terminalId ?? null;
    const isCurrentTarget = () => {
      const currentTab = activePaneTabRef.current;
      const currentTerminalId = isLocalResourceTab(currentTab) ? null : currentTab?.terminalId ?? null;
      return generation === mediaLoadGenerationRef.current
        && paneId === (currentTab?.id ?? null)
        && terminalId === currentTerminalId;
    };
    setMediaViewer(null);
    setMediaError('');
    setIsLoadingMedia(true);
    try {
      const url = await readFileAsDataUrl(file.path, terminalId);
      if (!isCurrentTarget()) return;
      setMediaViewer({ url, name: file.name, kind });
      setStatusMessage(`正在查看：${file.name}`);
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