import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";

const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#334155",
  matchBorder: "#64748b",
  matchOverviewRuler: "#64748b",
  activeMatchBackground: "#d97706",
  activeMatchBorder: "#fbbf24",
  activeMatchColorOverviewRuler: "#f59e0b"
};

export type TerminalSearchResult = {
  resultIndex: number;
  resultCount: number;
};

type UseTerminalSearchOptions = {
  restoreFocus: () => void;
};

export function useTerminalSearch({ restoreFocus }: UseTerminalSearchOptions) {
  const addonRef = useRef<SearchAddon | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef(restoreFocus);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<TerminalSearchResult>({ resultIndex: -1, resultCount: 0 });

  useEffect(() => {
    restoreFocusRef.current = restoreFocus;
  }, [restoreFocus]);

  const options = useMemo(
    () => createTerminalSearchOptions({ caseSensitive, wholeWord }),
    [caseSensitive, wholeWord]
  );

  useEffect(() => {
    if (!open) return;
    const addon = addonRef.current;
    if (!addon || !query) {
      addon?.clearDecorations();
      setResult({ resultIndex: -1, resultCount: 0 });
      return;
    }
    addon.findNext(query, { ...options, incremental: true });
  }, [open, options, query]);

  const attachAddon = useCallback((addon: SearchAddon) => {
    addonRef.current = addon;
    const resultDisposable = addon.onDidChangeResults((next) => setResult(next));
    return () => {
      resultDisposable.dispose();
      if (addonRef.current === addon) addonRef.current = null;
    };
  }, []);

  const openSearch = useCallback(() => {
    setOpen(true);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  const closeSearch = useCallback(() => {
    addonRef.current?.clearDecorations();
    setOpen(false);
    setResult({ resultIndex: -1, resultCount: 0 });
    window.setTimeout(() => restoreFocusRef.current(), 0);
  }, []);

  const findNext = useCallback(() => {
    if (!query) return;
    addonRef.current?.findNext(query, createTerminalSearchOptions({ caseSensitive, wholeWord }));
  }, [caseSensitive, query, wholeWord]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    addonRef.current?.findPrevious(query, createTerminalSearchOptions({ caseSensitive, wholeWord }));
  }, [caseSensitive, query, wholeWord]);

  const onPanelKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    event.stopPropagation();
    openSearch();
  }, [openSearch]);

  return {
    open,
    query,
    caseSensitive,
    wholeWord,
    result,
    inputRef,
    attachAddon,
    openSearch,
    closeSearch,
    findNext,
    findPrevious,
    setQuery,
    setCaseSensitive,
    setWholeWord,
    onPanelKeyDownCapture
  };
}

export function createTerminalSearchOptions({
  caseSensitive,
  wholeWord
}: {
  caseSensitive: boolean;
  wholeWord: boolean;
}): ISearchOptions {
  return {
    caseSensitive,
    wholeWord,
    decorations: SEARCH_DECORATIONS
  };
}

export function formatTerminalSearchResult({ resultIndex, resultCount }: TerminalSearchResult) {
  if (resultCount <= 0 || resultIndex < 0) return `0/${resultCount}`;
  return `${resultIndex + 1}/${resultCount}`;
}
