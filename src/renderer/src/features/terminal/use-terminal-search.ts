import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#334155",
  matchBorder: "#64748b",
  matchOverviewRuler: "#64748b",
  activeMatchBackground: "#d97706",
  activeMatchBorder: "#fbbf24",
  activeMatchColorOverviewRuler: "#f59e0b"
};
const SEARCH_WORD_SEPARATORS = " ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?\t\r\n";

export type TerminalSearchResult = {
  resultIndex: number;
  resultCount: number;
};

type UseTerminalSearchOptions = {
  restoreFocus: () => void;
};

export function useTerminalSearch({ restoreFocus }: UseTerminalSearchOptions) {
  const addonRef = useRef<SearchAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
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
      clearTerminalSearch(addon);
      setResult({ resultIndex: -1, resultCount: 0 });
      return;
    }
    runTerminalSearch(addon, "next", query, { ...options, incremental: true });
    const resultCount = countTerminalSearchMatches(terminalRef.current, query, options);
    setResult({ resultIndex: resultCount > 0 ? 0 : -1, resultCount });
  }, [open, options, query]);

  const attachAddon = useCallback((addon: SearchAddon, terminal: Terminal) => {
    addonRef.current = addon;
    terminalRef.current = terminal;
    return () => {
      if (addonRef.current === addon) addonRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
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
    clearTerminalSearch(addonRef.current);
    setOpen(false);
    setResult({ resultIndex: -1, resultCount: 0 });
    window.setTimeout(() => restoreFocusRef.current(), 0);
  }, []);

  const findNext = useCallback(() => {
    if (!query) return;
    const addon = addonRef.current;
    if (!addon) return;
    const searchOptions = createTerminalSearchOptions({ caseSensitive, wholeWord });
    runTerminalSearch(addon, "next", query, searchOptions);
    const resultCount = countTerminalSearchMatches(terminalRef.current, query, searchOptions);
    setResult((current) => advanceTerminalSearchResult(current, resultCount, "next"));
  }, [caseSensitive, query, wholeWord]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    const addon = addonRef.current;
    if (!addon) return;
    const searchOptions = createTerminalSearchOptions({ caseSensitive, wholeWord });
    runTerminalSearch(addon, "previous", query, searchOptions);
    const resultCount = countTerminalSearchMatches(terminalRef.current, query, searchOptions);
    setResult((current) => advanceTerminalSearchResult(current, resultCount, "previous"));
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

type TerminalSearchDirection = "next" | "previous";

export function runTerminalSearch(
  addon: SearchAddon,
  direction: TerminalSearchDirection,
  query: string,
  options: ISearchOptions
) {
  try {
    return invokeTerminalSearch(addon, direction, query, options);
  } catch (error) {
    console.error("Terminal search decorations failed; retrying without decorations.", error);
    try {
      return invokeTerminalSearch(addon, direction, query, {
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        incremental: options.incremental
      });
    } catch (fallbackError) {
      console.error("Terminal search failed.", fallbackError);
      return false;
    }
  }
}

export function countTerminalTextMatches(
  content: string,
  query: string,
  options: Pick<ISearchOptions, "caseSensitive" | "wholeWord">
) {
  if (!query) return 0;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const haystack = options.caseSensitive ? content : content.toLowerCase();
  let count = 0;
  let start = 0;
  while (start <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) break;
    if (!options.wholeWord || isWholeWordMatch(haystack, index, needle.length)) count += 1;
    start = index + 1;
  }
  return count;
}

export function advanceTerminalSearchResult(
  current: TerminalSearchResult,
  resultCount: number,
  direction: TerminalSearchDirection
): TerminalSearchResult {
  if (resultCount <= 0) return { resultIndex: -1, resultCount: 0 };
  if (current.resultIndex < 0 || current.resultCount !== resultCount) {
    return { resultIndex: direction === "previous" ? resultCount - 1 : 0, resultCount };
  }
  const delta = direction === "previous" ? -1 : 1;
  return {
    resultIndex: (current.resultIndex + delta + resultCount) % resultCount,
    resultCount
  };
}

function countTerminalSearchMatches(
  terminal: Terminal | null,
  query: string,
  options: Pick<ISearchOptions, "caseSensitive" | "wholeWord">
) {
  if (!terminal || !query) return 0;
  const buffer = terminal.buffer.active;
  const logicalLines: string[] = [];
  let logicalLine = "";
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const content = line.translateToString(true);
    if (line.isWrapped) {
      logicalLine += content;
      continue;
    }
    if (logicalLine) logicalLines.push(logicalLine);
    logicalLine = content;
  }
  if (logicalLine) logicalLines.push(logicalLine);
  return countTerminalTextMatches(logicalLines.join("\n"), query, options);
}

function isWholeWordMatch(content: string, index: number, length: number) {
  const left = index === 0 || SEARCH_WORD_SEPARATORS.includes(content[index - 1]);
  const rightIndex = index + length;
  const right = rightIndex === content.length || SEARCH_WORD_SEPARATORS.includes(content[rightIndex]);
  return left && right;
}

function invokeTerminalSearch(
  addon: SearchAddon,
  direction: TerminalSearchDirection,
  query: string,
  options: ISearchOptions
) {
  if (direction === "previous") return addon.findPrevious(query, options);
  return addon.findNext(query, options);
}

function clearTerminalSearch(addon: SearchAddon | null) {
  if (!addon) return;
  try {
    addon.clearDecorations();
  } catch (error) {
    console.error("Failed to clear terminal search decorations.", error);
  }
}
