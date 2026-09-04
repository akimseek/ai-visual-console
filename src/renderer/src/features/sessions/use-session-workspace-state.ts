import { useMemo, useState } from "react";
import type { AiSession } from "../../types";
import { sessionCacheKey, type SessionCacheKey, type SessionView } from "./use-session-loader";

// 会话工作区集中维护视图、缓存和选中状态，避免 App.tsx 分散管理同一组会话状态。
export function useSessionWorkspaceState({ targetId }: { targetId: string }) {
  const [view, setView] = useState<SessionView>("active");
  const [sessionCache, setSessionCache] = useState<Record<SessionCacheKey, AiSession[]>>({});
  const [loadedViews, setLoadedViews] = useState<Record<SessionCacheKey, boolean>>({});
  const [selectedId, setSelectedId] = useState("");
  const [sessionLoading, setSessionLoading] = useState(false);

  const cacheKey = useMemo<SessionCacheKey | null>(
    () => (targetId ? sessionCacheKey(targetId, view) : null),
    [targetId, view]
  );
  const sessions = useMemo(
    () => (cacheKey ? sessionCache[cacheKey] || [] : []),
    [cacheKey, sessionCache]
  );
  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) || null,
    [selectedId, sessions]
  );
  const activeViewLoaded = Boolean(targetId && loadedViews[sessionCacheKey(targetId, "active")]);

  return {
    view,
    setView,
    sessionCache,
    setSessionCache,
    loadedViews,
    setLoadedViews,
    selectedId,
    setSelectedId,
    sessionLoading,
    setSessionLoading,
    cacheKey,
    sessions,
    selected,
    activeViewLoaded
  };
}
