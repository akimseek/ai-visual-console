import { useEffect } from "react";
import type { AiSession } from "../../types";
import { useBatchSelection } from "../../hooks/use-batch-selection";
import { useSessionSearch } from "./use-session-search";
import type { SessionCacheKey, SessionView } from "./use-session-loader";

type SessionLoader = (
  targetId?: string,
  view?: SessionView,
  force?: boolean
) => Promise<void>;

export function shouldLoadSessionList(
  targetId: string,
  cacheKey: SessionCacheKey | null,
  loadedViews: Record<SessionCacheKey, boolean>
) {
  return Boolean(targetId && cacheKey && !loadedViews[cacheKey]);
}

// 会话列表统一编排搜索和批量选择，自动加载仍由页面按现有时序触发。
export function useSessionListState({
  targetId,
  view,
  cacheKey,
  sessions,
  loadedViews,
  loadSessions,
  setError
}: {
  targetId: string;
  view: SessionView;
  cacheKey: SessionCacheKey | null;
  sessions: AiSession[];
  loadedViews: Record<SessionCacheKey, boolean>;
  loadSessions: SessionLoader;
  setError: (message: string) => void;
}) {
  const search = useSessionSearch({
    targetId,
    view,
    cacheKey,
    sessions,
    setError
  });
  const batch = useBatchSelection(sessions, search.filtered);

  useEffect(() => {
    if (!shouldLoadSessionList(targetId, cacheKey, loadedViews)) return;
    void loadSessions(targetId, view);
  }, [cacheKey, loadSessions, loadedViews, targetId, view]);

  return {
    ...search,
    ...batch
  };
}
