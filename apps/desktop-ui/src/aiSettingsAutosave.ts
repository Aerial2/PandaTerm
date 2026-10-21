export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** 串行写入，只保留最新草稿；flush 用于关闭或切换账号前等待落盘。 */
export function createSettingsAutosave<T>(options: {
  save: (draft: T) => Promise<void>;
  equal: (left: T, right: T) => boolean;
  onStatus: (status: AutosaveStatus) => void;
  delay?: number;
}) {
  let latest: T | undefined;
  let persisted: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | undefined;
  let disposed = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function dirty() {
    return latest !== undefined && (persisted === undefined || !options.equal(latest, persisted));
  }

  async function drain(): Promise<boolean> {
    while (!disposed && dirty()) {
      const snapshot = latest!;
      options.onStatus('saving');
      try {
        await options.save(snapshot);
        persisted = snapshot;
      } catch {
        // 新输入可继续保存；失败的当前草稿保留，等待重试或下一次编辑。
        if (latest !== undefined && !options.equal(snapshot, latest)) continue;
        options.onStatus('error');
        return false;
      }
    }
    if (!disposed) options.onStatus('saved');
    return !disposed;
  }

  function flush(): Promise<boolean> {
    clearTimer();
    if (running) return running;
    if (!dirty()) return Promise.resolve(true);
    running = drain().finally(() => { running = undefined; });
    return running;
  }

  return {
    update(draft: T) {
      if (disposed || (latest !== undefined && options.equal(latest, draft))) return;
      const wasDirty = dirty();
      latest = draft;
      clearTimer();
      if (!dirty() && !running) {
        if (wasDirty) options.onStatus('idle');
        return;
      }
      options.onStatus(running ? 'saving' : 'pending');
      timer = setTimeout(() => { void flush(); }, options.delay ?? 600);
    },
    reset(draft: T) {
      clearTimer();
      latest = draft;
      persisted = draft;
      options.onStatus('idle');
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      latest = undefined;
      persisted = undefined;
    },
  };
}
