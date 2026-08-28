import { memo, useMemo } from "react";
import type { MouseEvent } from "react";
import type { AiSession } from "../../types";
import { formatRelative } from "../../lib/format";

// 侧栏会话列表：复选框批量选择 + 打开会话 + 右键菜单。从 App.tsx 的内联 JSX 抽出为展示组件。
// 用 memo 包裹：列表数据未变（如流式 usage 更新触发的父级重渲染）时跳过整列表重渲染，
// 前提是父级传入的回调引用稳定（见 App.tsx 的 useStableCallback）。
export const SessionList = memo(function SessionList({
  sessions,
  loading,
  emptyMessage,
  activeSessionId,
  selectedId,
  selectedBatchIds,
  onContextMenu,
  onToggleBatch,
  onOpen
}: {
  sessions: AiSession[];
  loading: boolean;
  emptyMessage: string;
  activeSessionId?: string;
  selectedId?: string;
  selectedBatchIds: string[];
  onContextMenu: (event: MouseEvent<HTMLElement>, session: AiSession) => void;
  onToggleBatch: (id: string) => void;
  onOpen: (session: AiSession) => void;
}) {
  // 用 Set 做选中判定，避免每行 includes() 造成的 O(n²)。
  const selectedBatchIdSet = useMemo(() => new Set(selectedBatchIds), [selectedBatchIds]);
  return (
    <section className="session-list" aria-label="会话列表">
      {!loading && sessions.length === 0 && <div className="empty-state">{emptyMessage}</div>}
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`session-row ${activeSessionId === session.id || selectedId === session.id ? "active" : ""}`}
          title={session.title}
          onContextMenu={(event) => onContextMenu(event, session)}
        >
          <input
            className="session-select"
            type="checkbox"
            checked={selectedBatchIdSet.has(session.id)}
            onChange={(event) => {
              event.stopPropagation();
              onToggleBatch(session.id);
            }}
            onClick={(event) => event.stopPropagation()}
            title="选择会话"
          />
          <button className="session-open" type="button" onClick={() => onOpen(session)}>
            <span className="session-time">{formatRelative(session.updatedAt || session.createdAt)}</span>
            <span className="session-summary">
              <span className="session-title">{session.title}</span>
            </span>
          </button>
        </div>
      ))}
    </section>
  );
});
