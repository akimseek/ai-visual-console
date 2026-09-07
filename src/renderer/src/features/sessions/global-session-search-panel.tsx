import { ArrowLeft, FileSearch, LoaderCircle, Search, TextSearch } from "lucide-react";
import type { AiTarget } from "../../types";
import { formatRelative } from "../../lib/format";
import type { GlobalSessionSearchResult } from "./global-session-search";

type GlobalSessionSearchPanelProps = {
  query: string;
  onQueryChange: (value: string) => void;
  providerFilter: string;
  onProviderFilterChange: (value: string) => void;
  targetFilter: string;
  onTargetFilterChange: (value: string) => void;
  searchContent: boolean;
  onSearchContentChange: (value: boolean) => void;
  targets: AiTarget[];
  results: GlobalSessionSearchResult[];
  summaryLoading: boolean;
  contentLoading: boolean;
  message: string;
  onBack: () => void;
  onOpen: (result: GlobalSessionSearchResult) => void;
};

export function GlobalSessionSearchPanel({
  query,
  onQueryChange,
  providerFilter,
  onProviderFilterChange,
  targetFilter,
  onTargetFilterChange,
  searchContent,
  onSearchContentChange,
  targets,
  results,
  summaryLoading,
  contentLoading,
  message,
  onBack,
  onOpen
}: GlobalSessionSearchPanelProps) {
  const visibleTargets = targets.filter((target) => !providerFilter || target.provider === providerFilter);
  const providers = Array.from(new Map(targets.map((target) => [target.provider, target.provider])).values());
  const loading = summaryLoading || contentLoading;

  return (
    <section className="global-session-search" aria-label="全局会话检索">
      <header className="global-session-search-header">
        <button type="button" className="global-session-search-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2} />
          返回会话
        </button>
        <span>{loading ? <LoaderCircle className="is-spinning" aria-label="正在检索" size={15} /> : <FileSearch aria-hidden="true" size={15} />}</span>
      </header>

      <div className="global-session-search-query">
        <Search aria-hidden="true" size={16} strokeWidth={2} />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索全部活跃会话"
          aria-label="搜索全部活跃会话"
        />
      </div>

      <div className="global-session-search-filters">
        <select aria-label="按平台筛选" value={providerFilter} onChange={(event) => onProviderFilterChange(event.target.value)}>
          <option value="">全部平台</option>
          {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
        <select aria-label="按目标筛选" value={targetFilter} onChange={(event) => onTargetFilterChange(event.target.value)}>
          <option value="">全部目标</option>
          {visibleTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
        </select>
      </div>

      <button
        type="button"
        className={`global-session-search-content${searchContent ? " active" : ""}`}
        aria-pressed={searchContent}
        disabled={!query.trim() || summaryLoading}
        onClick={() => onSearchContentChange(!searchContent)}
      >
        <TextSearch aria-hidden="true" size={15} strokeWidth={1.9} />
        搜索消息正文
      </button>

      {message && <p className="global-session-search-message" role="status">{message}</p>}
      {!query.trim() && !summaryLoading && <p className="global-session-search-empty">输入关键字后，将从已知目标的活跃会话中检索。</p>}
      {query.trim() && !loading && results.length === 0 && <p className="global-session-search-empty">未找到匹配会话。</p>}

      <div className="global-session-search-results" aria-live="polite" aria-busy={loading}>
        {results.map((result) => (
          <button
            key={`${result.target.id}:${result.session.id}:${result.session.filePath}`}
            type="button"
            className="global-session-search-result"
            disabled={!result.target.available}
            title={result.target.available ? `继续：${result.session.title}` : result.target.detail || "此目标当前不可运行。"}
            onClick={() => onOpen(result)}
          >
            <span className="global-session-search-result-meta">
              <span>{result.target.label}</span>
              <time>{formatRelative(result.session.updatedAt || result.session.createdAt)}</time>
            </span>
            <strong>{result.session.title}</strong>
            <span className="global-session-search-result-detail">
              {result.source === "content" ? "正文匹配" : result.session.model || result.session.cwd || "会话摘要"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
