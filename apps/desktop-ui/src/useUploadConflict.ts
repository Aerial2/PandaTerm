import { useRef, useState } from 'react';
import {
  buildDuplicateName,
  type ResourceFile,
  type UploadConflictApplyAll,
  type UploadConflictDecision,
  type UploadConflictDialogState,
} from './resourceModel';

// 上传冲突域：远程根目录出现同名文件时的覆盖/跳过/重命名决策。
// 用 Promise 把「等用户在对话框里选择」封装成 uploadFiles 可以 await 的异步调用。
// 用「队列」而不是单个 state 槽：批量上传的并发池可能同时触发多个冲突，
// 单槽会覆盖前一个 Promise 的 resolve，导致那个上传永久停在 pending。
export function useUploadConflict() {
  const [uploadConflictQueue, setUploadConflictQueue] = useState<UploadConflictDialogState[]>([]);
  // 记住「应用到全部」的选择，后续同批次冲突直接沿用、不再逐个弹窗。
  const uploadConflictApplyAllRef = useRef<UploadConflictApplyAll | null>(null);

  // 对外保持「单对话框」视图：始终显示队首；后续请求排队等待。
  const uploadConflictDialog = uploadConflictQueue[0] ?? null;

  // 兼容原对外 setter：以函数/值形式更新“当前显示中的”队首；传 null 视为关闭队首。
  function setUploadConflictDialog(
    next: UploadConflictDialogState | null | ((prev: UploadConflictDialogState | null) => UploadConflictDialogState | null),
  ) {
    setUploadConflictQueue((current) => {
      const head = current[0] ?? null;
      const resolved = typeof next === 'function'
        ? (next as (prev: UploadConflictDialogState | null) => UploadConflictDialogState | null)(head)
        : next;
      if (!resolved) return current.slice(1); // 关闭队首
      return [resolved, ...current.slice(1)];
    });
  }

  function requestUploadConflictDecision(
    source: File,
    target: ResourceFile,
    existingNames: Set<string>,
  ): Promise<UploadConflictDecision | null> {
    const applyAll = uploadConflictApplyAllRef.current;
    if (applyAll) {
      if (applyAll.action === 'rename') {
        return Promise.resolve({ action: 'rename', newName: buildDuplicateName(source.name, existingNames) });
      }
      return Promise.resolve({ action: applyAll.action });
    }

    return new Promise((resolve) => {
      const entry: UploadConflictDialogState = {
        sourceName: source.name,
        sourceSize: source.size,
        sourceModifiedMs: source.lastModified || null,
        target,
        existingNames: [...existingNames],
        action: 'overwrite',
        newName: buildDuplicateName(source.name, existingNames),
        applyToAll: false,
        resolve,
      };
      setUploadConflictQueue((current) => [...current, entry]);
    });
  }

  function resolveUploadConflictDialog(decision: UploadConflictDecision | null) {
    const head = uploadConflictQueue[0];
    if (!head) return;
    if (head.applyToAll && decision) {
      uploadConflictApplyAllRef.current = { action: decision.action };
    }
    head.resolve(decision);
    setUploadConflictQueue((current) => current.slice(1));
  }

  return {
    uploadConflictDialog,
    setUploadConflictDialog,
    requestUploadConflictDecision,
    resolveUploadConflictDialog,
  };
}
