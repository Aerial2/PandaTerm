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
export function useUploadConflict() {
  const [uploadConflictDialog, setUploadConflictDialog] = useState<UploadConflictDialogState | null>(null);
  // 记住「应用到全部」的选择，后续同批次冲突直接沿用、不再逐个弹窗。
  const uploadConflictApplyAllRef = useRef<UploadConflictApplyAll | null>(null);

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
      setUploadConflictDialog({
        sourceName: source.name,
        sourceSize: source.size,
        sourceModifiedMs: source.lastModified || null,
        target,
        existingNames: [...existingNames],
        action: 'overwrite',
        newName: buildDuplicateName(source.name, existingNames),
        applyToAll: false,
        resolve,
      });
    });
  }

  function resolveUploadConflictDialog(decision: UploadConflictDecision | null) {
    const dialog = uploadConflictDialog;
    if (!dialog) return;
    if (dialog.applyToAll && decision) {
      uploadConflictApplyAllRef.current = { action: decision.action };
    }
    dialog.resolve(decision);
    setUploadConflictDialog(null);
  }

  return {
    uploadConflictDialog,
    setUploadConflictDialog,
    requestUploadConflictDecision,
    resolveUploadConflictDialog,
  };
}