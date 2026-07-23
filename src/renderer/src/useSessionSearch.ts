import { useEffect, useMemo, useState } from "react";
import type { AiSession } from "./types";
import { localFilterSessions } from "./sessionFormat";
import type { SessionCacheKey, SessionView } from "./useSessionLoader";

type SearchState = {
  key: SessionCacheKey;
  query: string;
  sessions: AiSession[];
  loading: boolean;
};

export function useSessionSearch({
  targetId,
  view,
  cacheKey,
  sessions,
  setError
}: {
  targetId: string;
  view: SessionView;
  cacheKey: SessionCacheKey | null;
  sessions: AiSession[];
  setError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const searchQuery = query.trim();
  const localFiltered = useMemo(() => localFilterSessions(sessions, searchQuery), [searchQuery, sessions]);
  const searchMatchesCurrentView = Boolean(cacheKey && searchState?.key === cacheKey && searchState.query === searchQuery);
  const filtered = searchQuery && searchMatchesCurrentView ? searchState?.sessions || [] : localFiltered;
  const searchLoading = Boolean(searchQuery && searchMatchesCurrentView && searchState?.loading);

  useEffect(() => {
    if (!targetId || !cacheKey) return;
    if (!searchQuery) {
      setSearchState(null);
      return;
    }

    let cancelled = false;
    const fallback = localFilterSessions(sessions, searchQuery);
    setSearchState((current) => {
      if (current?.key === cacheKey && current.query === searchQuery) return { ...current, loading: true };
      return { key: cacheKey, query: searchQuery, sessions: fallback, loading: true };
    });
    const timer = window.setTimeout(() => {
      void window.codexConsole
        .searchSessions(targetId, view, searchQuery)
        .then((items) => {
          if (!cancelled) setSearchState({ key: cacheKey, query: searchQuery, sessions: items, loading: false });
        })
        .catch((error: any) => {
          if (!cancelled) {
            setSearchState({ key: cacheKey, query: searchQuery, sessions: fallback, loading: false });
            setError(error?.message || "全文搜索失败。");
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetId, view, cacheKey, searchQuery, sessions, setError]);

  return { query, setQuery, searchQuery, filtered, searchLoading };
}
