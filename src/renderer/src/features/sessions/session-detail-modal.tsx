import { useRef, useState } from "react";
import type { AiSession } from "../../types";
import { formatDate } from "../../lib/format";
import { shortSessionId } from "./session-format";
import { BranchPanel } from "./branch-panel";
import type { BranchPanelState } from "./branch-panel";
import { buildConversationTurns, type ConversationTurn } from "./conversation";

const COLLAPSE_MESSAGE_LENGTH = 4_000;

function MessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSE_MESSAGE_LENGTH;
  const visibleText = collapsible && !expanded ? `${text.slice(0, COLLAPSE_MESSAGE_LENGTH)}...` : text;
  return (
    <>
      <p>{visibleText}</p>
      {collapsible && <button type="button" className="message-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开"}</button>}
    </>
  );
}

// 会话详情弹框：展示完整对话（按问答轮次分组）、分支关系，并按轮次提供“从此处分支”。
// 从 App.tsx 的内联 JSX + renderSessionDetailContent 抽出为独立组件。
export function SessionDetailModal({
  session,
  selectedSessionDetails,
  loading,
  branchPanel,
  supportsBranch,
  hasMore,
  loadingMore,
  onLoadMore,
  onClose,
  onOpenSession,
  onBranchFromTurn
}: {
  session: AiSession;
  selectedSessionDetails: AiSession | null;
  loading: boolean;
  branchPanel: BranchPanelState | null;
  supportsBranch: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onClose: () => void;
  onOpenSession: (session: AiSession) => void;
  onBranchFromTurn: (session: AiSession, turn: ConversationTurn) => void;
}) {
  const detailSession = selectedSessionDetails?.id === session.id ? selectedSessionDetails : session;
  const bodyRef = useRef<HTMLDivElement>(null);

  async function loadEarlierMessages() {
    const body = bodyRef.current;
    const previousHeight = body?.scrollHeight || 0;
    await onLoadMore();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (body) body.scrollTop += body.scrollHeight - previousHeight;
  }

  function handleBodyScroll() {
    if (hasMore && !loadingMore && (bodyRef.current?.scrollTop || 0) < 24) void loadEarlierMessages();
  }

  return (
    <div className="session-detail-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="session-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="会话详情"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 title={detailSession.title}>{detailSession.title}</h2>
            <span>{shortSessionId(session.id)}</span>
          </div>
          <button type="button" aria-label="关闭详情" onClick={onClose}>
            ×
          </button>
        </header>
        <div ref={bodyRef} className="session-detail-modal-body" onScroll={handleBodyScroll}>
          {loading ? (
            <div className="detail-loading">正在加载完整会话...</div>
          ) : (
            <>
              <BranchPanel session={detailSession} state={branchPanel} onOpen={onOpenSession} />
              {hasMore && <button type="button" className="secondary" disabled={loadingMore} onClick={() => void loadEarlierMessages()}>{loadingMore ? "正在加载..." : "加载更早消息"}</button>}
              {buildConversationTurns(detailSession.preview || [], detailSession.previewOffset).map((turn, turnIndex) => (
                <article key={`turn-${turnIndex}`} className="conversation-turn">
                  {turn.user && (
                    <div className="conversation-block conversation-question">
                      <article className={`message ${turn.user.message.role}`}>
                        <header>
                          <div className="message-meta">
                            <span>{turn.user.message.role}</span>
                            <time>{formatDate(turn.user.message.timestamp)}</time>
                          </div>
                        </header>
                        <MessageText text={turn.user.message.text} />
                      </article>
                    </div>
                  )}
                  <div className="conversation-block conversation-answer">
                    {turn.replies.map((entry) => (
                      <article key={`${entry.message.timestamp}-${entry.index}`} className={`message ${entry.message.role}`}>
                        <header>
                          <div className="message-meta">
                            <span>{entry.message.role}</span>
                            <time>{formatDate(entry.message.timestamp)}</time>
                          </div>
                        </header>
                        <MessageText text={entry.message.text} />
                      </article>
                    ))}
                    {supportsBranch && (
                      <div className="conversation-actions">
                        <button
                          type="button"
                          className="message-branch"
                          onClick={() => onBranchFromTurn(detailSession, turn)}
                        >
                          从此处分支
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
