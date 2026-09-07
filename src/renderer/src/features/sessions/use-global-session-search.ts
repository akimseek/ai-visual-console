import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiSession, AiTarget } from "../../types";
import {
  createSummarySearchResults,
  filterGlobalSearchEntries,
  mergeContentSearchResults,
  uniqueSearchTargets,
  type GlobalSessionSearchEntry,
  type GlobalSessionSearchResult
} from "./global-session-search";

const TARGET_SUMMARY_CONCURRENCY = 3;
const CONTENT_SEARCH_CONCURRENCY = 3;
const CONTENT_SEARCH_DEBOUNCE_MS = 250;

export function useGlobalSessionSearch(currentTarget?: AiTarget) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [searchContent, setSearchContent] = useState(false);
  const [entries, setEntries] = useState<GlobalSessionSearchEntry[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [contentResults, setContentResults] = useState<GlobalSessionSearchResult[]>([]);
  const requestVersion = useRef(0);

  const targets = useMemo(() => entries.map((entry) => entry.target), [entries]);
  const filteredEntries = useMemo(
    () => filterGlobalSearchEntries(entries, providerFilter, targetFilter),
    [entries, providerFilter, targetFilter]
  );
  const summaryResults = useMemo(
    () => createSummarySearchResults(entries, query, providerFilter, targetFilter),
    [entries, providerFilter, query, targetFilter]
  );
  const results = useMemo(
    () => searchContent ? mergeContentSearchResults(summaryResults, contentResults) : summaryResults,
    [contentResults, searchContent, summaryResults]
  );

  const close = useCallback(() => {
    requestVersion.current += 1;
    setOpen(false);
    setQuery("");
    setProviderFilter("");
    setTargetFilter("");
    setSearchContent(false);
    setContentResults([]);
    setContentLoading(false);
    setMessage("");
  }, []);

  useEffect(() => {
    if (!open) return;
    const version = ++requestVersion.current;
    setSummaryLoading(true);
    setMessage("");
    setEntries([]);

    void (async () => {
      const cachedTargets = await window.codexConsole.listCachedTargets().catch(() => [] as AiTarget[]);
      const knownTargets = uniqueSearchTargets(cachedTargets, currentTarget);
      const failedTargets: string[] = [];
      const loaded = await mapWithConcurrency(knownTargets, TARGET_SUMMARY_CONCURRENCY, async (target) => {
        try {
          const cached = await window.codexConsole.listCachedSessions(target.id, "active");
          const sessions = cached.length > 0 ? cached : await window.codexConsole.listSessions(target.id);
          return { target, sessions };
        } catch {
          failedTargets.push(target.label);
          return { target, sessions: [] as AiSession[] };
        }
      });

      if (requestVersion.current !== version) return;
      setEntries(loaded);
      setSummaryLoading(false);
      if (failedTargets.length > 0) {
        setMessage(`部分目标无法读取会话：${failedTargets.join("、")}`);
      }
    })().catch(() => {
      if (requestVersion.current !== version) return;
      setSummaryLoading(false);
      setMessage("读取全局会话索引失败。");
    });

    return () => { requestVersion.current += 1; };
  }, [currentTarget, open]);

  useEffect(() => {
    if (!searchContent || !query.trim() || filteredEntries.length === 0) {
      setContentResults([]);
      setContentLoading(false);
      return;
    }
    const version = ++requestVersion.current;
    setContentLoading(true);
    const timer = window.setTimeout(() => {
      void mapWithConcurrency(filteredEntries, CONTENT_SEARCH_CONCURRENCY, async ({ target }) => {
        try {
          const sessions = await window.codexConsole.searchSessions(target.id, "active", query.trim());
          return sessions.map((session) => ({ target, session, source: "content" as const }));
        } catch {
          return [] as GlobalSessionSearchResult[];
        }
      }).then((groups) => {
        if (requestVersion.current !== version) return;
        setContentResults(groups.flat());
        setContentLoading(false);
      });
    }, CONTENT_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      requestVersion.current += 1;
    };
  }, [filteredEntries, query, searchContent]);

  function updateProviderFilter(value: string) {
    setProviderFilter(value);
    setTargetFilter((current) => entries.some(({ target }) => target.id === current && (!value || target.provider === value)) ? current : "");
  }

  return {
    open,
    openSearch: () => setOpen(true),
    close,
    query,
    setQuery,
    providerFilter,
    setProviderFilter: updateProviderFilter,
    targetFilter,
    setTargetFilter,
    searchContent,
    setSearchContent,
    targets,
    results,
    summaryLoading,
    contentLoading,
    message
  };
}

async function mapWithConcurrency<T, TResult>(items: T[], limit: number, mapper: (item: T) => Promise<TResult>) {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
