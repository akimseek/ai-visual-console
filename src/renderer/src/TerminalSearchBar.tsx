import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { formatTerminalSearchResult, type TerminalSearchResult } from "./useTerminalSearch";

type TerminalSearchBarProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  result: TerminalSearchResult;
  onQueryChange: (query: string) => void;
  onCaseSensitiveChange: (enabled: boolean) => void;
  onWholeWordChange: (enabled: boolean) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
};

export function TerminalSearchBar({
  inputRef,
  query,
  caseSensitive,
  wholeWord,
  result,
  onQueryChange,
  onCaseSensitiveChange,
  onWholeWordChange,
  onNext,
  onPrevious,
  onClose
}: TerminalSearchBarProps) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) onPrevious();
    else onNext();
  }

  return (
    <div className="terminal-search" role="search" onMouseDown={(event) => event.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        aria-label="搜索终端内容"
        placeholder="搜索终端内容"
        spellCheck={false}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="terminal-search-count" aria-live="polite">
        {formatTerminalSearchResult(result)}
      </span>
      <button
        type="button"
        className={caseSensitive ? "active" : ""}
        aria-label="区分大小写"
        aria-pressed={caseSensitive}
        title="区分大小写"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        Aa
      </button>
      <button
        type="button"
        className={wholeWord ? "active" : ""}
        aria-label="全词匹配"
        aria-pressed={wholeWord}
        title="全词匹配"
        onClick={() => onWholeWordChange(!wholeWord)}
      >
        全词
      </button>
      <button type="button" disabled={!query} aria-label="上一个匹配项" title="上一个（Shift + Enter）" onClick={onPrevious}>
        ↑
      </button>
      <button type="button" disabled={!query} aria-label="下一个匹配项" title="下一个（Enter）" onClick={onNext}>
        ↓
      </button>
      <button type="button" aria-label="关闭搜索" title="关闭（Esc）" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
