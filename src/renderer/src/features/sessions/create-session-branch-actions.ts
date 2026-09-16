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
        if (branch.id === session.id) throw new Error("Codex 返回了与原会话相同的分支编号，已拒绝打开以避免覆盖原会话。");
        await loadActiveSessions(sourceTargetId);
        setBranchPanel((current) =>
          current?.targetId === sourceTargetId && current.sessionId === session.id
            ? { ...current, children: mergeSession(current.children, branch), loading: false }
            : current
        );
        openDerivedSession(branch, sourceTargetId, sourceTarget);
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
