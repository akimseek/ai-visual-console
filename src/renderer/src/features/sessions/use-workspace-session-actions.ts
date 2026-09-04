import type { Dispatch, RefObject, SetStateAction, MouseEvent, WheelEvent } from "react";
import type { AiProviderId, AiSession } from "../../types";
import type { TerminalTab } from "../terminal/terminal-tab-state";
import type { SessionView } from "./use-session-loader";
import type { TerminalInputState } from "../terminal/terminal-workspace";

export type SessionContextMenuState = {
  x: number;
  y: number;
  session: AiSession;
  view: SessionView;
};

export type TabContextMenuState = {
  x: number;
  y: number;
  tabKey: string;
};

// 工作区动作只负责协调状态和既有 Hook，不直接处理 IPC 或业务数据。
export function useWorkspaceSessionActions(options: {
  workspaceRef: RefObject<HTMLElement | null>;
  terminalTabsRef: RefObject<HTMLDivElement | null>;
  view: SessionView;
  targetId: string;
  providerId: AiProviderId | "";
  supportsTrash: boolean;
  activeTab: TerminalTab | null;
  activeTerminalInputState: TerminalInputState | null;
  canToggleTerminalInput: boolean;
  openSessionTabWithCwdCheck: (session: AiSession, openResumeWithDirectory: (session: AiSession, cwd: string) => void) => Promise<void>;
  selectedSession: AiSession | null;
  activeSession: AiSession | null;
  selectedSessionDetails: AiSession | null;
  applySessionSnapshot: (targetId: string, session: AiSession) => void;
  loadSessions: (targetId: string, view: SessionView, force?: boolean) => Promise<void>;
  loadTargets: (providerId: AiProviderId, options?: { showLoading?: boolean }) => Promise<void>;
  refreshSessionSnapshot: (targetId: string, sessionId: string, filePath?: string) => Promise<AiSession | null>;
  invalidateLoadedView: (targetId: string, view: SessionView) => void;
  clearPendingTerminalTab: () => void;
  setView: Dispatch<SetStateAction<SessionView>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setSelectedBatchIds: Dispatch<SetStateAction<string[]>>;
  setSelectedSessionDetails: Dispatch<SetStateAction<AiSession | null>>;
  setSelectedSessionLoading: Dispatch<SetStateAction<boolean>>;
  setDetailDialogSession: Dispatch<SetStateAction<AiSession | null>>;
  setContextMenu: Dispatch<SetStateAction<SessionContextMenuState | null>>;
  setTabContextMenu: Dispatch<SetStateAction<TabContextMenuState | null>>;
  setTerminalInputState: (tabKey: string, state: TerminalInputState) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  openResumeWithDirectory: (session: AiSession, cwd: string) => void;
}) {
  const {
    workspaceRef,
    terminalTabsRef,
    view,
    targetId,
    providerId,
    supportsTrash,
    activeTab,
    activeTerminalInputState,
    canToggleTerminalInput,
    openSessionTabWithCwdCheck,
    selectedSession,
    activeSession,
    selectedSessionDetails,
    applySessionSnapshot,
    loadSessions,
    loadTargets,
    refreshSessionSnapshot,
    clearPendingTerminalTab,
    setView,
    setSelectedId,
    setSelectedBatchIds,
    setSelectedSessionDetails,
    setSelectedSessionLoading,
    setDetailDialogSession,
    setContextMenu,
    setTabContextMenu,
    setTerminalInputState,
    setError,
    setNotice,
    openResumeWithDirectory
  } = options;

  async function refreshCurrentView() {
    if (!targetId) {
      if (providerId) await loadTargets(providerId, { showLoading: true });
      return;
    }
    await loadSessions(targetId, view, true);
    const session = selectedSessionDetails || activeSession || selectedSession;
    if (session) {
      const refreshed = await refreshSessionSnapshot(targetId, session.id, session.filePath);
      if (refreshed) applySessionSnapshot(targetId, refreshed);
    }
  }

  async function refreshProviderTargets() {
    if (providerId) await loadTargets(providerId, { showLoading: true });
  }

  function invalidateLoadedView(nextTargetId: string, nextView: SessionView) {
    // 由调用方注入加载状态更新，避免该 Hook 复制缓存结构。
    options.invalidateLoadedView(nextTargetId, nextView);
  }

  function switchView(nextView: SessionView) {
    if (nextView === "trash" && !supportsTrash) return;
    setView(nextView);
    setSelectedId("");
    setSelectedBatchIds([]);
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(false);
    setDetailDialogSession(null);
    setContextMenu(null);
    clearPendingTerminalTab();
  }

  function openSessionTab(session: AiSession) {
    if (view === "trash") {
      setSelectedId(session.id);
      return;
    }
    void openSessionTabWithCwdCheck(session, openResumeWithDirectory);
  }

  function openSessionDetail(session: AiSession) {
    setSelectedId(session.id);
    setDetailDialogSession(session);
    setError("");
    setNotice("");
  }

  function openSessionContextMenu(event: MouseEvent<HTMLElement>, session: AiSession) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, session, view });
  }

  function handleTerminalTabsWheel(event: WheelEvent<HTMLDivElement>) {
    const tabs = terminalTabsRef.current;
    if (!tabs || tabs.scrollWidth <= tabs.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    tabs.scrollLeft += delta;
  }

  function openTerminalTabContextMenu(event: MouseEvent<HTMLElement>, tabKey: string) {
    event.preventDefault();
    event.stopPropagation();
    const bounds = workspaceRef.current?.getBoundingClientRect();
    const menuWidth = 132;
    const menuHeight = 114;
    const gap = 8;
    const maxX = bounds ? bounds.right - menuWidth - gap : window.innerWidth - menuWidth - gap;
    const maxY = bounds ? bounds.bottom - menuHeight - gap : window.innerHeight - menuHeight - gap;
    const minX = bounds ? bounds.left + gap : gap;
    const minY = bounds ? bounds.top + gap : gap;
    const x = Math.min(Math.max(event.clientX, minX), Math.max(minX, maxX));
    const y = Math.min(Math.max(event.clientY, minY), Math.max(minY, maxY));
    setTabContextMenu({ x, y, tabKey });
  }

  function toggleActiveTerminalInputMode() {
    if (!activeTab || !canToggleTerminalInput) return;
    const nextMode = activeTerminalInputState?.mode === "composer" ? "terminal" : "composer";
    setTerminalInputState(activeTab.key, { composerVisible: true, mode: nextMode });
  }

  return {
    refreshCurrentView,
    refreshProviderTargets,
    invalidateLoadedView,
    switchView,
    openSessionTab,
    openSessionDetail,
    openSessionContextMenu,
    handleTerminalTabsWheel,
    openTerminalTabContextMenu,
    toggleActiveTerminalInputMode
  };
}
