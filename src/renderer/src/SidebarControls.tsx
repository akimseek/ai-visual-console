type SessionView = "active" | "trash";

// 侧栏控件区：会话视图切换、全文搜索框、批量操作工具条。从 App.tsx 的内联 JSX 抽出为展示组件。
export function SidebarControls({
  view,
  supportsTrash,
  onSwitchView,
  query,
  onQueryChange,
  searchActive,
  searchLoading,
  resultCount,
  supportsBatchActions,
  selectedCount,
  allSelected,
  onToggleAll,
  onRestoreBatch,
  onPurgeBatch,
  onDeleteBatch
}: {
  view: SessionView;
  supportsTrash: boolean;
  onSwitchView: (view: SessionView) => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchActive: boolean;
  searchLoading: boolean;
  resultCount: number;
  supportsBatchActions: boolean;
  selectedCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onRestoreBatch: () => void;
  onPurgeBatch: () => void;
  onDeleteBatch: () => void;
}) {
  return (
    <>
      <div className="view-switch" role="tablist" aria-label="会话视图">
        <button className={view === "active" ? "active" : ""} onClick={() => onSwitchView("active")}>
          当前会话
        </button>
        {supportsTrash && (
          <button className={view === "trash" ? "active" : ""} onClick={() => onSwitchView("trash")}>
            回收站
          </button>
        )}
      </div>

      <input
        className="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={view === "trash" ? "搜索回收站会话全文" : "搜索会话全文、工作目录、模型"}
      />
      {searchActive && (
        <div className="search-status" aria-live="polite">
          {searchLoading ? "正在全文搜索..." : `全文搜索结果 ${resultCount} 个`}
        </div>
      )}
      {supportsBatchActions && (
        <div className="batch-toolbar">
          <label>
            <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
            <span>已选 {selectedCount}</span>
          </label>
          {view === "trash" ? (
            <>
              <button type="button" disabled={selectedCount === 0} onClick={onRestoreBatch}>
                恢复
              </button>
              <button type="button" className="danger" disabled={selectedCount === 0} onClick={onPurgeBatch}>
                彻底删除
              </button>
            </>
          ) : (
            <>
              <button type="button" className="danger" disabled={selectedCount === 0} onClick={onDeleteBatch}>
                删除
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
