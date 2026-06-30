import type { AiSession } from "./types";
import { formatDate } from "./format";
import { shortSessionId } from "./sessionFormat";
import { BranchPanel } from "./BranchPanel";
import type { BranchPanelState } from "./BranchPanel";
import { buildConversationTurns, type ConversationTurn } from "./conversation";

// 会话详情弹框：展示完整对话（按问答轮次分组）、分支关系，并按轮次提供“从此处分支”。
// 从 App.tsx 的内联 JSX + renderSessionDetailContent 抽出为独立组件。
export function SessionDetailModal({
  session,
  selectedSessionDetails,
  loading,
  branchPanel,
  supportsBranch,
  onClose,
  onOpenSession,
  onBranchFromTurn
}: {
  session: AiSession;
  selectedSessionDetails: AiSession | null;
  loading: boolean;
  branchPanel: BranchPanelState | null;
  supportsBranch: boolean;
  onClose: () => void;
  onOpenSession: (session: AiSession) => void;
  onBranchFromTurn: (session: AiSession, turn: ConversationTurn) => void;
}) {
  const detailSession = selectedSessionDetails?.id === session.id ? selectedSessionDetails : session;

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
        <div className="session-detail-modal-body">
          {loading ? (
            <div className="detail-loading">正在加载完整会话...</div>
          ) : (
            <>
              <BranchPanel session={detailSession} state={branchPanel} onOpen={onOpenSession} />
              {buildConversationTurns(detailSession.preview || []).map((turn, turnIndex) => (
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
                        <p>{turn.user.message.text}</p>
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
                        <p>{entry.message.text}</p>
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
