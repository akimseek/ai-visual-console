import { useRef } from "react";
import type { AiSession } from "../../types";
import type { TerminalTab } from "../terminal/terminal-tab-state";

export function findNewSessionCandidates(sessions: AiSession[], tab: TerminalTab) {
  return sessions.filter((session) => {
    if (tab.knownSessionIds?.includes(session.id)) return false;
    if (tab.cwd && session.cwd && tab.cwd !== session.cwd) return false;
    const updatedAt = Date.parse(session.updatedAt || session.createdAt || "");
    return !tab.createdAt || (Number.isFinite(updatedAt) && updatedAt >= tab.createdAt - 10_000);
  });
}

export function useNewSessionFinalizer({
  listAndCacheSessions,
  applyCustomTitle
}: {
  listAndCacheSessions: (targetId: string) => Promise<AiSession[]>;
  applyCustomTitle: (targetId: string, sessionId: string, title: string) => Promise<void>;
}) {
  const pendingTabs = useRef(new Set<string>());

  async function finalizeNewSession(tab: TerminalTab) {
    if (pendingTabs.current.has(tab.key)) return;
    pendingTabs.current.add(tab.key);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sessions = await listAndCacheSessions(tab.targetId);
        if (!tab.customTitle) return;
        const candidates = findNewSessionCandidates(sessions, tab);
        if (candidates.length === 1) {
          await applyCustomTitle(tab.targetId, candidates[0].id, tab.customTitle);
          return;
        }
        if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      }
    } catch {
      // 标题回填失败不影响 CLI 会话；用户仍可从列表重命名。
    } finally {
      pendingTabs.current.delete(tab.key);
    }
  }

  return { finalizeNewSession };
}
