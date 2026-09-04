import type { Dispatch, SetStateAction } from "react";
import type { AiSession } from "../../types";
import { historyTabTitle } from "./use-session-tabs";
import { sessionCacheKey, type SessionCacheKey, type SessionView } from "./use-session-loader";
import { applySessionCustomTitle } from "./session-cache-mutations";
import { replaceCachedSession } from "./session-format";
import type { TerminalTab } from "../terminal/terminal-tab-state";
import type { BranchPanelState } from "./branch-panel";

// 会话缓存的跨组件同步集中在这里，避免重命名、详情刷新和终端标签各自维护一份逻辑。
export function useSessionCacheOperations(options: {
  setSessionCache: Dispatch<SetStateAction<Record<SessionCacheKey, AiSession[]>>>;
  setOpenTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setSelectedSessionDetails: Dispatch<SetStateAction<AiSession | null>>;
  setDetailDialogSession: Dispatch<SetStateAction<AiSession | null>>;
  setBranchPanel: Dispatch<SetStateAction<BranchPanelState | null>>;
}) {
  const {
    setSessionCache,
    setOpenTabs,
    setSelectedSessionDetails,
    setDetailDialogSession,
    setBranchPanel
  } = options;

  function updateCachedSessions(
    targetId: string,
    view: SessionView,
    updater: (sessions: AiSession[]) => AiSession[]
  ) {
    const key = sessionCacheKey(targetId, view);
    setSessionCache((current) => ({ ...current, [key]: updater(current[key] || []) }));
  }

  function applySessionSnapshot(targetId: string, session: AiSession) {
    updateCachedSessions(targetId, "active", (current) => replaceCachedSession(current, session));
    updateCachedSessions(targetId, "trash", (current) => replaceCachedSession(current, session));
    setOpenTabs((current) => current.map((tab) =>
      tab.targetId === targetId && tab.session?.id === session.id
        ? { ...tab, session, title: historyTabTitle(session) }
        : tab
    ));
  }

  function applyCustomTitle(targetId: string, sessionId: string, metadata: AiSession["metadata"]) {
    const rename = (session: AiSession) => session.id === sessionId ? applySessionCustomTitle(session, metadata) : session;
    updateCachedSessions(targetId, "active", (current) => current.map(rename));
    updateCachedSessions(targetId, "trash", (current) => current.map(rename));
    setOpenTabs((current) => current.map((tab) => {
      if (tab.targetId !== targetId || tab.session?.id !== sessionId) return tab;
      const session = applySessionCustomTitle(tab.session, metadata);
      return { ...tab, session, title: historyTabTitle(session) };
    }));
    setSelectedSessionDetails((current) => current?.id === sessionId ? applySessionCustomTitle(current, metadata) : current);
    setDetailDialogSession((current) => current?.id === sessionId ? applySessionCustomTitle(current, metadata) : current);
    setBranchPanel((current) => current ? {
      ...current,
      parent: current.parent?.id === sessionId ? applySessionCustomTitle(current.parent, metadata) : current.parent,
      children: current.children.map(rename)
    } : current);
  }

  return { updateCachedSessions, applySessionSnapshot, applyCustomTitle };
}
