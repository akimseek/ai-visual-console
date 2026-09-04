import { useRef, type Dispatch, type SetStateAction } from "react";
import type { AiSession, AiTarget } from "../../types";
import type { TerminalTab } from "../terminal/terminal-tab-state";
import { tabKey } from "./session-format";
import type { SessionView } from "./use-session-loader";
import type { NoticeState } from "../../hooks/use-app-notice";

type SetNotice = (message: string, action?: { label: string; onClick: () => void }, tone?: NoticeState["tone"]) => void;

export const DEFAULT_NEW_SESSION_CWD = "~/.akim";

export function historyTabTitle(session: AiSession) {
  return session.metadata?.customTitle?.trim() || session.id;
}

// 会话与终端标签的打开/关闭动作：打开历史会话、新建会话、目录恢复、分支派生，
// 以及退出终端后的会话列表刷新。App 只保留视图级的轻量包装。
export function useSessionTabs(options: {
  targetId: string;
  selectedTarget: AiTarget | undefined;
  targets: AiTarget[];
  sessions: AiSession[];
  openTabs: TerminalTab[];
  terminalIdsByTabKey: Record<string, string>;
  activateTerminalTab: (tab: TerminalTab, pending?: boolean) => void;
  closeTerminalTabs: (keys: string[]) => void;
  releaseTabVendor: (tabKey: string) => void;
  invalidateLoadedView: (targetId: string, view: SessionView) => void;
  loadSessions: (targetId?: string, view?: SessionView, force?: boolean) => Promise<void>;
  finalizeNewSession: (tab: TerminalTab) => Promise<void>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setView: Dispatch<SetStateAction<SessionView>>;
  setDetailDialogSession: Dispatch<SetStateAction<AiSession | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: SetNotice;
}) {
  const {
    targetId,
    selectedTarget,
    targets,
    sessions,
    openTabs,
    terminalIdsByTabKey,
    activateTerminalTab,
    closeTerminalTabs,
    releaseTabVendor,
    invalidateLoadedView,
    loadSessions,
    finalizeNewSession,
    setSelectedId,
    setView,
    setDetailDialogSession,
    setError,
    setNotice
  } = options;

  // 新会话编号只用于生成标签键和默认标题，用 ref 即可，无需触发重渲染。
  const newSessionIndexRef = useRef(1);

  // 工作目录已失效的历史会话需要换目录恢复，弹框由 App 侧的 useNewSessionDialog 提供，
  // 通过参数注入以避免 Hook 之间的循环依赖。
  async function openSessionTabWithCwdCheck(session: AiSession, openResumeWithDirectory: (session: AiSession, cwd: string) => void) {
    setSelectedId(session.id);
    const sessionCwd = session.cwd?.trim();
    if (sessionCwd) {
      const exists = await window.codexConsole.pathExists({ targetId, path: sessionCwd }).catch(() => false);
      if (!exists) {
        openResumeWithDirectory(session, sessionCwd);
        return;
      }
    }

    const key = tabKey(targetId, session.id);
    const requiresSessionCwd = selectedTarget?.provider === "qoder";
    activateTerminalTab({
      key,
      targetId,
      session,
      title: historyTabTitle(session),
      // Qoder 按项目目录定位 --resume 的历史文件，恢复时必须保留原始工作目录。
      cwd: requiresSessionCwd ? sessionCwd : undefined,
      codexHome: selectedTarget?.codexHome,
      useCodexCwdFlag: requiresSessionCwd
    });
    setError("");
    setNotice("");
  }

  function openNewSessionTab(
    nextTargetId = targetId,
    cwd = DEFAULT_NEW_SESSION_CWD,
    customTitle = "",
    prompt = "",
    cliArgs = ""
  ) {
    if (!nextTargetId) return;
    const index = newSessionIndexRef.current;
    const key = `new:${nextTargetId}:${Date.now()}:${index}`;
    const nextTarget = targets.find((target) => target.id === nextTargetId);
    const usesDefaultCwd = cwd === DEFAULT_NEW_SESSION_CWD;
    const displayTitle = customTitle.trim() || (index === 1 ? "新会话" : `新会话 ${index}`);
    newSessionIndexRef.current = index + 1;
    activateTerminalTab(
      {
        key,
        targetId: nextTargetId,
        title: displayTitle,
        cwd: usesDefaultCwd ? undefined : cwd,
        codexHome: nextTarget?.codexHome,
        useCodexCwdFlag: !usesDefaultCwd,
        prompt: prompt.trim() || undefined,
        cliArgs: cliArgs.trim() || undefined,
        customTitle: customTitle.trim() || undefined,
        knownSessionIds: sessions.map((session) => session.id),
        createdAt: Date.now()
      },
      true
    );
    setError("");
    setNotice("");
  }

  function openResumeSessionWithDirectory(session: AiSession, cwd: string) {
    const key = tabKey(targetId, session.id);
    activateTerminalTab({
      key,
      targetId,
      session,
      title: historyTabTitle(session),
      cwd,
      codexHome: selectedTarget?.codexHome,
      useCodexCwdFlag: true
    });
    setError("");
    setNotice("");
  }

  function openDerivedSession(session: AiSession) {
    const key = tabKey(targetId, session.id);
    setView("active");
    setDetailDialogSession(null);
    activateTerminalTab({
      key,
      targetId,
      session,
      title: historyTabTitle(session),
      codexHome: selectedTarget?.codexHome
    }, true);
    setError("");
    setNotice("已创建新的分支会话。");
  }

  function closeSessionTab(key: string) {
    releaseTabVendor(key);
    closeTerminalTabs([key]);
  }

  function closeOtherSessionTabs(key: string) {
    closeTerminalTabs(openTabs.filter((tab) => tab.key !== key).map((tab) => tab.key));
  }

  function closeAllSessionTabs() {
    closeTerminalTabs(openTabs.map((tab) => tab.key));
  }

  async function closeOpenSessionTerminal(session: AiSession) {
    const key = tabKey(targetId, session.id);
    const terminalId = terminalIdsByTabKey[key];
    if (terminalId) await window.codexConsole.stopTerminal(terminalId);
    closeSessionTab(key);
  }

  function handleTerminalExit(tabKey: string, exitCode: number) {
    if (exitCode !== 0) return;
    const tab = openTabs.find((item) => item.key === tabKey);
    if (tab?.session) {
      // 终端已退出，只需更新左侧会话摘要；不要为此完整解析大型 JSONL。
      invalidateLoadedView(tab.targetId, "active");
      void loadSessions(tab.targetId, "active", true);
    } else if (tab?.targetId) {
      void finalizeNewSession(tab);
    }
    closeSessionTab(tabKey);
  }

  return {
    openSessionTabWithCwdCheck,
    openNewSessionTab,
    openResumeSessionWithDirectory,
    openDerivedSession,
    closeSessionTab,
    closeOtherSessionTabs,
    closeAllSessionTabs,
    closeOpenSessionTerminal,
    handleTerminalExit
  };
}
