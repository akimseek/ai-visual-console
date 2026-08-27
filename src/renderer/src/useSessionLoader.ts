import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { AiSession } from "./types";
import { captureError } from "./errorUtils";

export type SessionView = "active" | "trash";
export type SessionCacheKey = `${string}:${SessionView}`;

type UseSessionLoaderOptions = {
  targetId: string;
  view: SessionView;
  loadedViews: Record<SessionCacheKey, boolean>;
  setSessionCache: Dispatch<SetStateAction<Record<SessionCacheKey, AiSession[]>>>;
  setLoadedViews: Dispatch<SetStateAction<Record<SessionCacheKey, boolean>>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setSessionLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  preserveActiveSessions: (sessions: AiSession[], targetId: string) => AiSession[];
  logPerformance: (label: string, durationMs: number, status?: string) => Promise<void>;
};

export function sessionCacheKey(targetId: string, view: SessionView): SessionCacheKey {
  return `${targetId}:${view}` as SessionCacheKey;
}

export function useSessionLoader({
  targetId,
  view,
  loadedViews,
  setSessionCache,
  setLoadedViews,
  setSelectedId,
  setSessionLoading,
  setError,
  preserveActiveSessions,
  logPerformance
}: UseSessionLoaderOptions) {
  const versions = useRef(new Map<SessionCacheKey, number>());

  return useCallback(async (nextTargetId = targetId, nextView = view, force = false) => {
    if (!nextTargetId) return;
    const cacheKey = sessionCacheKey(nextTargetId, nextView);
    if (!force && loadedViews[cacheKey]) return;
    const version = (versions.current.get(cacheKey) || 0) + 1;
    versions.current.set(cacheKey, version);
    const isCurrent = () => versions.current.get(cacheKey) === version;

    setSessionLoading(true);
    setError("");
    let hasCachedSessions = false;
    if (!force) {
      const startedAt = performance.now();
      try {
        const cachedItems = await window.codexConsole.listCachedSessions(nextTargetId, nextView);
        void logPerformance(`renderer.sessions.${nextView}.cached.${nextTargetId}`, performance.now() - startedAt);
        if (cachedItems.length > 0) {
          if (!isCurrent()) return;
          hasCachedSessions = true;
          const sessions = nextView === "active" ? preserveActiveSessions(cachedItems, nextTargetId) : cachedItems;
          setSessionCache((current) => ({ ...current, [cacheKey]: sessions }));
          setLoadedViews((current) => ({ ...current, [cacheKey]: true }));
          setSelectedId((current) => (sessions.some((item) => item.id === current) ? current : ""));
          setSessionLoading(false);
          return;
        }
      } catch (error) {
        captureError(error, `loadCachedSessions:${nextTargetId}`);
        void logPerformance(`renderer.sessions.${nextView}.cached.${nextTargetId}`, performance.now() - startedAt, "error");
      }
    }

    const startedAt = performance.now();
    try {
      const items = nextView === "trash"
        ? await window.codexConsole.listTrashSessions(nextTargetId)
        : await window.codexConsole.listSessions(nextTargetId);
      if (!isCurrent()) return;
      const sessions = nextView === "active" ? preserveActiveSessions(items, nextTargetId) : items;
      setSessionCache((current) => ({ ...current, [cacheKey]: sessions }));
      setLoadedViews((current) => ({ ...current, [cacheKey]: true }));
      setSelectedId((current) => (sessions.some((item) => item.id === current) ? current : ""));
      void logPerformance(`renderer.sessions.${nextView}.loaded.${nextTargetId}`, performance.now() - startedAt);
    } catch (error) {
      if (!isCurrent()) return;
      if (!hasCachedSessions) {
        setSessionCache((current) => ({ ...current, [cacheKey]: [] }));
        setLoadedViews((current) => ({ ...current, [cacheKey]: true }));
        setSelectedId("");
        setError(captureError(error, `loadSessions:${nextTargetId}`, "加载 AI 会话失败。"));
      }
      void logPerformance(`renderer.sessions.${nextView}.loaded.${nextTargetId}`, performance.now() - startedAt, "error");
    } finally {
      if (!hasCachedSessions && isCurrent()) setSessionLoading(false);
    }
  }, [
    loadedViews,
    logPerformance,
    preserveActiveSessions,
    setError,
    setLoadedViews,
    setSelectedId,
    setSessionCache,
    setSessionLoading,
    targetId,
    view
  ]);
}
