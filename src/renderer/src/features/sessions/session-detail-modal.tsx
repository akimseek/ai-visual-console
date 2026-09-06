import { useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, X } from "lucide-react";
import type { AiSession } from "../../types";
import { formatDate } from "../../lib/format";
import { shortSessionId } from "./session-format";
import { BranchPanel } from "./branch-panel";
import type { BranchPanelState } from "./branch-panel";
import { buildConversationTurns, type ConversationMessageEntry, type ConversationTurn } from "./conversation";

const COLLAPSE_MESSAGE_LENGTH = 4_000;

function MessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSE_MESSAGE_LENGTH;
  const visibleText = collapsible && !expanded ? `${text.slice(0, COLLAPSE_MESSAGE_LENGTH)}...` : text;
  return (
    <>
      <p>{visibleText}</p>
      {collapsible && (
        <button
          type="button"
          className="message-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
          <span>{expanded ? "收起" : "展开"}</span>
        </button>
      )}
    </>
  );
}

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

  const turns = buildConversationTurns(detailSession.preview || [], detailSession.previewOffset);

  return (
    <div className="session-detail-modal-overlay" role="presentation" onMouseDown={onClose}>
      <section className="session-detail-modal" role="dialog" aria-modal="true" aria-label="会话详情" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="session-detail-heading">
            <span className="session-detail-eyebrow">会话详情</span>
            <h2 title={detailSession.title}>{detailSession.title}</h2>
            <span className="session-detail-subtitle">{shortSessionId(session.id)} · {detailSession.messageCount} 条消息</span>
          </div>
          <button type="button" className="session-detail-close" aria-label="关闭会话详情" onClick={onClose}>
            <X aria-hidden="true" size={18} strokeWidth={1.9} />
          </button>
        </header>
        <div ref={bodyRef} className="session-detail-modal-body" onScroll={handleBodyScroll}>
          {loading ? <div className="detail-loading">正在加载完整会话...</div> : (
            <>
              <BranchPanel session={detailSession} state={branchPanel} onOpen={onOpenSession} />
              <section className="session-detail-timeline" aria-label="会话时间线">
                <div className="session-detail-timeline-heading">
                  <span>消息记录</span>
                  <span>{detailSession.messageCount} 条</span>
                </div>
                {hasMore && (
                  <div className="session-detail-history-boundary">
                    <span className="session-detail-history-line" aria-hidden="true" />
                    <button type="button" className="session-detail-load-earlier" disabled={loadingMore} onClick={() => void loadEarlierMessages()}>
                      <ArrowUp aria-hidden="true" size={15} />
                      {loadingMore ? "正在加载更早消息..." : "加载更早消息"}
                    </button>
                    <span className="session-detail-history-line" aria-hidden="true" />
                  </div>
                )}
                {turns.map((turn, turnIndex) => (
                  <article key={`turn-${turnIndex}`} className="conversation-turn">
                    {turn.user && <div className="conversation-block conversation-question"><MessageArticle entry={turn.user} /></div>}
                    <div className="conversation-block conversation-answer">
                      {turn.replies.map((entry) => <MessageArticle key={`${entry.message.timestamp}-${entry.index}`} entry={entry} />)}
                      {supportsBranch && <div className="conversation-actions"><button type="button" className="message-branch" onClick={() => onBranchFromTurn(detailSession, turn)}>从此处分支</button></div>}
                    </div>
                  </article>
                ))}
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function MessageArticle({ entry }: { entry: ConversationMessageEntry }) {
  return <article className={`message ${entry.message.role}`}>
    <header><div className="message-meta"><span>{entry.message.role}</span><time>{formatDate(entry.message.timestamp)}</time></div></header>
    <MessageText text={entry.message.text} />
  </article>;
}
