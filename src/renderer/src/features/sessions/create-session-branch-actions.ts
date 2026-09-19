import type { Dispatch, SetStateAction } from "react";
import type { BranchPanelState } from "./branch-panel";
import type { ConversationTurn } from "./conversation";
import { mergeSession } from "./session-format";
import type { AiSession, AiTarget } from "../../types";

export function createSessionBranchActions({
  targetId,
  runWorkspaceAction,
  loadActiveSessions,
  setBranchPanel,
  openDerivedSession,
  setError,
  setNotice,
  clearPendingTerminalTab
}: {
  targetId: string;
  runWorkspaceAction: (
    message: string,
    action: () => Promise<unknown>,
    options?: { errorAsNotice?: boolean }
  ) => Promise<void>;
  loadActiveSessions: (targetId?: string) => Promise<void>;
  setBranchPanel: Dispatch<SetStateAction<BranchPanelState | null>>;
  openDerivedSession: (session: AiSession, sourceTargetId?: string, sourceTarget?: AiTarget) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  clearPendingTerminalTab: () => void;
}) {
  async function branchFromTurn(session: AiSession, turn: ConversationTurn, sourceTargetId = targetId, sourceTarget?: AiTarget) {
    setError("");
    setNotice("");
    clearPendingTerminalTab();
    try {
      await runWorkspaceAction("正在创建分支会话...", async () => {
        const messageLine = getBranchMessageLine(turn);
        if (messageLine <= 0) throw new Error("当前会话没有可保留的上下文。");
        const branch = await window.codexConsole.branchSession({ targetId: sourceTargetId, sessionId: session.id, messageLine });
        if (branch.id === session.id) throw new Error("Codex 返回了与原会话相同的分支会话编号，已停止打开分支。");
        let refreshFailed = false;
        try {
          await loadActiveSessions(sourceTargetId);
        } catch {
          // 分支已由 Codex 成功创建；列表刷新失败不应把已存在的分支误报为创建失败。
          refreshFailed = true;
        }
        setBranchPanel((current) =>
          current?.targetId === sourceTargetId && current.sessionId === session.id
            ? { ...current, children: mergeSession(current.children, branch), loading: false }
            : current
        );
        openDerivedSession(branch, sourceTargetId, sourceTarget);
        if (refreshFailed) setNotice("分支已创建，但会话列表刷新失败，请稍后手动刷新。");
      }, { errorAsNotice: true });
    } finally {
      clearPendingTerminalTab();
    }
  }

  return { branchFromTurn };
}

function getBranchMessageLine(turn: ConversationTurn) {
  for (let index = turn.replies.length - 1; index >= 0; index -= 1) {
    const entry = turn.replies[index];
    if (entry.message.role === "assistant") return entry.message.sourceLine || 0;
  }
  if (turn.replies.length > 0) return turn.replies[turn.replies.length - 1].message.sourceLine || 0;
  return turn.user?.message.sourceLine || 0;
}
