import type { AiSession } from "./types";
import { formatRelative } from "./format";
import { shortSessionId } from "./sessionFormat";

// 会话详情中的“分支关系”面板：展示来源会话与子分支，从 App.tsx 抽出为独立组件。

export type BranchPanelState = {
  sessionId: string;
  parent?: AiSession | null;
  children: AiSession[];
  loading: boolean;
};

export function BranchPanel({
  session,
  state,
  onOpen
}: {
  session: AiSession;
  state: BranchPanelState | null;
  onOpen: (session: AiSession) => void;
}) {
  const branch = session.metadata?.branch;
  const hasParent = Boolean(branch?.parentSessionId);
  const children = state?.sessionId === session.id ? state.children : [];
  const parent = state?.sessionId === session.id ? state.parent : null;
  const loading = state?.sessionId === session.id && state.loading;

  if (!hasParent && children.length === 0 && !loading) return null;

  return (
    <section className="branch-panel" aria-label="分支关系">
      <header>
        <h3>分支关系</h3>
        {loading && <span>正在加载...</span>}
      </header>
      {hasParent && (
        <div className="branch-row">
          <span className="branch-label">来源</span>
          {parent ? (
            <button type="button" onClick={() => onOpen(parent)} title={parent.title}>
              {parent.title}
            </button>
          ) : (
            <code>{shortSessionId(branch!.parentSessionId || "")}</code>
          )}
          {typeof branch?.parentMessageIndex === "number" && <small>消息 {branch.parentMessageIndex}</small>}
        </div>
      )}
      {(children.length > 0 || loading) && (
        <div className="branch-children">
          <span className="branch-label">子分支</span>
          <div>
            {children.map((child) => (
              <button key={child.id} type="button" onClick={() => onOpen(child)} title={child.title}>
                <span>{child.title}</span>
                <small>{formatRelative(child.updatedAt || child.createdAt)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
