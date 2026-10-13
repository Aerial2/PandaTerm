import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearRecentFiles,
  listRecentFiles,
  listSessions,
  removeRecentFile,
  upsertRecentFile,
  type RecentFile,
} from './api';

export type UseRecentFilesResult = {
  records: RecentFile[];
  loading: boolean;
  error: string | null;
  query: string;
  setQuery: (query: string) => void;
  currentSessionIds: string[] | null;
  recordOpen: (file: RecentFile) => Promise<void>;
  remove: (file: RecentFile) => Promise<void>;
  clear: (files: RecentFile[]) => Promise<void>;
  refreshSessions: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Recent-file state and mutations share a queue so an older response cannot overwrite a newer one. */
export function useRecentFiles(): UseRecentFilesResult {
  const [records, setRecords] = useState<RecentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [currentSessionIds, setCurrentSessionIds] = useState<string[] | null>(null);
  const mountedRef = useRef(true);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const task = queueRef.current.then(async () => {
      if (!mountedRef.current) return;
      setLoading(true);
      try {
        await operation();
      } catch (operationError) {
        if (mountedRef.current) setError(errorMessage(operationError));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    });
    queueRef.current = task.catch(() => undefined);
    return task.catch(() => undefined);
  }, []);

  const refreshSessions = useCallback((): Promise<void> => enqueue(async () => {
    try {
      const sessions = await listSessions();
      if (!mountedRef.current) return;
      setCurrentSessionIds(sessions.map((session) => session.id));
      // Session discovery cannot resolve an existing history storage error.
    } catch (sessionError) {
      if (mountedRef.current) setCurrentSessionIds(null);
      throw sessionError;
    }
  }), [enqueue]);

  const recordOpen = useCallback((file: RecentFile): Promise<void> => enqueue(async () => {
    // Always obtain a fresh session list. An unavailable list must never become an empty fallback.
    const sessionIds = await listSessions().then(
      (sessions) => sessions.map((session) => session.id),
      (sessionError: unknown) => {
        if (mountedRef.current) setCurrentSessionIds(null);
        throw sessionError;
      },
    );
    if (!mountedRef.current) return;
    setCurrentSessionIds(sessionIds);
    const nextRecords = await upsertRecentFile(file, sessionIds);
    if (!mountedRef.current) return;
    setRecords(nextRecords);
    setError(null);
  }), [enqueue]);

  const remove = useCallback((file: RecentFile): Promise<void> => enqueue(async () => {
    const nextRecords = await removeRecentFile(file);
    if (!mountedRef.current) return;
    setRecords(nextRecords);
    setError(null);
  }), [enqueue]);

  const clear = useCallback((files: RecentFile[]): Promise<void> => enqueue(async () => {
    const nextRecords = await clearRecentFiles(files);
    if (!mountedRef.current) return;
    setRecords(nextRecords);
    setError(null);
  }), [enqueue]);

  useEffect(() => {
    mountedRef.current = true;
    void enqueue(async () => {
      let firstError: string | null = null;
      try {
        const nextRecords = await listRecentFiles();
        if (mountedRef.current) setRecords(nextRecords);
      } catch (loadError) {
        firstError = errorMessage(loadError);
      }
      if (!mountedRef.current) return;
      try {
        const sessions = await listSessions();
        if (mountedRef.current) setCurrentSessionIds(sessions.map((session) => session.id));
      } catch (loadError) {
        firstError ??= errorMessage(loadError);
      }
      if (mountedRef.current && firstError) setError(firstError);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [enqueue]);

  return {
    records,
    loading,
    error,
    query,
    setQuery,
    currentSessionIds,
    recordOpen,
    remove,
    clear,
    refreshSessions,
  };
}
