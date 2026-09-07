import { LayoutDashboard, MessagesSquare, Search } from "lucide-react";

type SessionView = "active" | "trash";

// 侧栏控件区：会话视图切换、全文搜索框、批量操作工具条。从 App.tsx 的内联 JSX 抽出为展示组件。
export function SidebarControls({
  workbenchOpen,
  globalSearchOpen,
  favoriteOpen,
  onOpenWorkbench,
  onOpenGlobalSearch,
  onOpenFavorites,
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
  workbenchOpen: boolean;
  globalSearchOpen: boolean;
  favoriteOpen: boolean;
  onOpenWorkbench: () => void;
  onOpenGlobalSearch: () => void;
  onOpenFavorites: () => void;
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
      <nav className="sidebar-navigation" aria-label="主视图">
        <button type="button" className={workbenchOpen ? "active" : ""} onClick={onOpenWorkbench}>
          <LayoutDashboard aria-hidden="true" size={15} strokeWidth={1.9} />
          工作台
        </button>
        <button type="button" className={!workbenchOpen ? "active" : ""} onClick={() => onSwitchView("active")}>
          <MessagesSquare aria-hidden="true" size={15} strokeWidth={1.9} />
          会话
        </button>
      </nav>

      {!workbenchOpen && !globalSearchOpen && <>
      <div className="view-switch has-trash" role="tablist" aria-label="会话视图">
        <button className={!favoriteOpen && view === "active" ? "active" : ""} onClick={() => onSwitchView("active")}>
          当前会话
        </button>
        <button className={favoriteOpen ? "active" : ""} onClick={onOpenFavorites}>
          收藏夹
        </button>
        <button
          className={!favoriteOpen && view === "trash" ? "active" : ""}
          disabled={!supportsTrash}
          title={supportsTrash ? "查看回收站" : "请选择支持回收站的平台"}
          onClick={() => onSwitchView("trash")}
        >
          回收站
        </button>
      </div>

      {!favoriteOpen && <>
      <div className="session-search-row">
        <input
          className="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索当前平台会话"
        />
        <button type="button" className="global-session-search-trigger" onClick={onOpenGlobalSearch}>
          <Search aria-hidden="true" size={15} strokeWidth={2} />
          全部会话
        </button>
      </div>
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
      </>}
      </>}
    </>
  );
}
