import type { Dispatch, SetStateAction } from "react";
import type { BranchPanelState } from "./BranchPanel";
import type { ConversationTurn } from "./conversation";
import { mergeSession } from "./sessionFormat";
import type { AiSession } from "./types";

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
  runWorkspaceAction: (message: string, action: () => Promise<unknown>) => Promise<void>;
  loadActiveSessions: () => Promise<void>;
  setBranchPanel: Dispatch<SetStateAction<BranchPanelState | null>>;
  openDerivedSession: (session: AiSession) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  clearPendingTerminalTab: () => void;
}) {
  async function branchFromTurn(session: AiSession, turn: ConversationTurn) {
    setError("");
    setNotice("");
    clearPendingTerminalTab();
    try {
      await runWorkspaceAction("正在创建分支会话...", async () => {
        const messageIndex = getBranchMessageCount(turn);
        if (messageIndex <= 0) throw new Error("当前会话没有可保留的上下文。");
        const branch = await window.codexConsole.branchSession({ targetId, sessionId: session.id, messageIndex });
        await loadActiveSessions();
        setBranchPanel((current) =>
          current?.sessionId === session.id
            ? { ...current, children: mergeSession(current.children, branch), loading: false }
            : current
        );
        openDerivedSession(branch);
      });
    } finally {
      clearPendingTerminalTab();
    }
  }

  return { branchFromTurn };
}

function getBranchMessageCount(turn: ConversationTurn) {
  for (let index = turn.replies.length - 1; index >= 0; index -= 1) {
    const entry = turn.replies[index];
    if (entry.message.role === "assistant") return entry.index + 1;
  }
  if (turn.replies.length > 0) return turn.replies[turn.replies.length - 1].index + 1;
  return turn.user ? turn.user.index + 1 : 0;
}
