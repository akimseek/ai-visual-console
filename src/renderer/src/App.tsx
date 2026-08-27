import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import type {
  AiSession,
  AppCommand,
  SessionExportFormat
} from "./types";
import { formatDate } from "./format";
import {
  formatContextUsage,
  formatModelStatus,
  formatTokenUsage,
  mergeSession,
  replaceCachedSession,
  tabKey
} from "./sessionFormat";
import { ProviderStatusDialog } from "./ProviderStatusDialog";
import { CliInstallerDialog } from "./CliInstallerDialog";
import { CompressionPromptManagerDialog } from "./CompressionPromptManagerDialog";
import { VendorManagerDialog } from "./VendorManagerDialog";
import { AppMenuBar } from "./AppMenuBar";
import { useVendors } from "./useVendors";
import { useCompressionPrompts } from "./useCompressionPrompts";
import { useCliInstaller } from "./useCliInstaller";
import { useSkills } from "./useSkills";
import { SkillManagerDialog } from "./SkillManagerDialog";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionSettingsDialog } from "./SessionSettingsDialog";
import { GatewayPortDialog } from "./GatewayPortDialog";
import { SessionDetailModal } from "./SessionDetailModal";
import { SessionContextMenu, TabContextMenu } from "./ContextMenus";
import { StatusBar } from "./StatusBar";
import { SessionList } from "./SessionList";
import { useStableCallback } from "./useStableCallback";
import { SidebarControls } from "./SidebarControls";
import { NoticeToast } from "./NoticeToast";
import { SidebarHeader } from "./SidebarHeader";
import { renderCompressionPrompt } from "./compressionPrompt";
import { sessionCacheKey, useSessionLoader, type SessionCacheKey, type SessionView } from "./useSessionLoader";
import { useAppMenuState } from "./useAppMenuState";
import { useProviderTargets } from "./useProviderTargets";
import { useSessionTitleDialogs } from "./useSessionTitleDialogs";
import { useTerminalTabs } from "./useTerminalTabs";
import { useNewSessionDialog } from "./useNewSessionDialog";
import { captureError } from "./errorUtils";
import { createSessionActions } from "./useSessionActions";
import { useSessionDetails } from "./useSessionDetails";
import { useSessionSearch } from "./useSessionSearch";
import { useBatchSelection } from "./useBatchSelection";
import { useAppNotice } from "./useAppNotice";
import { useWorkspaceAction } from "./useWorkspaceAction";
import { useContextReminder } from "./useContextReminder";
import { useSystemTerminal } from "./useSystemTerminal";
import { createAppMenus } from "./appMenus";
import { useSessionSettings } from "./useSessionSettings";
import { createSessionBranchActions } from "./createSessionBranchActions";
import { useNewSessionFinalizer } from "./newSessionFinalizer";
import { AppPortalLayer } from "./AppPortalLayer";
import { TerminalWorkspace, type TerminalInputState } from "./TerminalWorkspace";

type SessionContextMenuState = {
  x: number;
  y: number;
  session: AiSession;
  view: "active" | "trash";
};

type TabContextMenuState = {
  x: number;
  y: number;
  tabKey: string;
};

export function App() {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<SessionView>("active");
  const [sessionCache, setSessionCache] = useState<Record<SessionCacheKey, AiSession[]>>({});
  const [loadedViews, setLoadedViews] = useState<Record<SessionCacheKey, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState("");
  const [newSessionIndex, setNewSessionIndex] = useState(1);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const terminalTabsRef = useRef<HTMLDivElement | null>(null);
  const [providerStatusOpen, setProviderStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  const [gatewayPortOpen, setGatewayPortOpen] = useState(false);
  const [gatewayPortDraft, setGatewayPortDraft] = useState("0");
  const [gatewayPortStatus, setGatewayPortStatus] = useState<import("./types").GatewayPortStatus | null>(null);
  const [gatewayPortError, setGatewayPortError] = useState("");
  const [gatewayPortBusy, setGatewayPortBusy] = useState(false);
  const { openAppMenu, setOpenAppMenu } = useAppMenuState();
  const usageDetailsRef = useRef<HTMLDivElement | null>(null);

  const { notice, setNotice } = useAppNotice();

  async function openGatewayPortDialog() {
    setGatewayPortError("");
    try {
      const status = await window.codexConsole.getGatewayPort();
      setGatewayPortStatus(status);
      setGatewayPortDraft(String(status.configuredPort));
      setGatewayPortOpen(true);
    } catch (error) {
      setNotice(captureError(error, "getGatewayPort", "读取网关端口失败。"));
    }
  }

  async function saveGatewayPort() {
    const port = Number(gatewayPortDraft.trim());
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      setGatewayPortError("端口必须是 0 到 65535 之间的整数。端口 0 表示自动分配。");
      return;
    }
    setGatewayPortBusy(true);
    setGatewayPortError("");
    try {
      const result = await window.codexConsole.setGatewayPort(port);
      setGatewayPortStatus(result);
      setGatewayPortOpen(false);
      setNotice(result.applied
        ? `网关端口已设置为 ${result.configuredPort === 0 ? "自动分配" : result.configuredPort}。`
        : `网关端口已保存为 ${result.configuredPort}，当前 Gateway 仍使用端口 ${result.activePort}；新建终端时生效。`);
    } catch (error) {
      setGatewayPortError(captureError(error, "setGatewayPort", "保存网关端口失败。"));
    } finally {
      setGatewayPortBusy(false);
    }
  }
  const {
    systemTerminalOpen,
    systemTerminalMinimized,
    systemTerminalCreateSignal,
    openNewSystemTerminal,
    closeSystemTerminal,
    toggleSystemTerminalMinimized
  } = useSystemTerminal();
  const { workspaceBusyMessage, workspaceFocusRequest, runWorkspaceAction } = useWorkspaceAction({
    setError,
    setNotice,
    focusActiveInput: () => focusActiveWorkspaceInput(workspaceRef.current)
  });

  const {
    openTabs,
    setOpenTabs,
    activeTabKey,
    setActiveTabKey,
    terminalIdsByTabKey,
    terminalInputStatesByTabKey,
    activateTerminalTab,
    closeTerminalTabs,
    setTerminalInputState,
    registerTerminalReady,
    clearPendingTerminalTab
  } = useTerminalTabs({ setSelectedId });
  const activeTab = openTabs.find((tab) => tab.key === activeTabKey) || openTabs[0] || null;
  const activeSession = activeTab?.session || null;

  useEffect(() => {
    void logPerformance("renderer.mounted", performance.now());
  }, []);

  const {
    providers,
    providerId,
    setProviderId,
    targets,
    targetId,
    setTargetId,
    loadTargets
  } = useProviderTargets({ setError, logPerformance });

  const cacheKey = targetId ? sessionCacheKey(targetId, view) : null;
  const sessions = useMemo(() => (cacheKey ? sessionCache[cacheKey] || [] : []), [cacheKey, sessionCache]);
  const { query, setQuery, searchQuery, filtered, searchLoading } = useSessionSearch({
    targetId,
    view,
    cacheKey,
    sessions,
    setError
  });
  const {
    selectedBatchIds,
    setSelectedBatchIds,
    selectedBatchSessions,
    allVisibleSelected,
    toggleBatchSelection,
    toggleAllVisibleSessions
  } = useBatchSelection(sessions, filtered);

  useEffect(() => {
    if (!targetId || !cacheKey || loadedViews[cacheKey]) return;
    void loadSessions(targetId, view);
    // 仅在目标/视图/缓存键变化时加载；loadSessions 每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, view, cacheKey, loadedViews]);

  const loadSessions = useSessionLoader({
    targetId,
    view,
    loadedViews,
    setSessionCache,
    setLoadedViews,
    setSelectedId,
    setSessionLoading,
    setError,
    preserveActiveSessions: preserveOpenActiveSessions,
    logPerformance
  });
  const activeViewLoaded = Boolean(targetId && loadedViews[sessionCacheKey(targetId, "active")]);

  // 传给已 memo 的 SessionList 的稳定回调：身份恒定，避免父级重渲染时让 memo 失效；
  // 内部仍调用最新的处理函数实现（这些 function 声明已提升，可在此引用）。
  const handleSessionContextMenu = useStableCallback(openSessionContextMenu);
  const handleToggleBatchSelection = useStableCallback(toggleBatchSelection);
  const handleOpenSessionTab = useStableCallback(openSessionTab);

  const selected = sessions.find((session) => session.id === selectedId) || null;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const capabilities = selectedProvider?.capabilities;
  const selectedTarget = targets.find((target) => target.id === targetId);
  const activeTabForSelectedTarget = activeTab?.targetId === targetId ? activeTab : null;
  const activeSessionForSelectedTarget = activeTabForSelectedTarget?.session || null;
  const {
    sessionSettingsOpen,
    setSessionSettingsOpen,
    wslPathDraft,
    setWslPathDraft,
    openSessionSettingsDialog,
    configureWslCodexHome,
    clearWslCodexHome
  } = useSessionSettings({
    selectedTarget,
    view,
    loadTargets,
    loadSessions,
    invalidateLoadedView,
    setError,
    setNotice
  });
  const {
    newSessionDialogOpen,
    newSessionCwd,
    newSessionTitle,
    setNewSessionTitle,
    newSessionPrompt,
    setNewSessionPrompt,
    newSessionCliArgs,
    setNewSessionCliArgs,
    pendingResumeSession,
    openNewSessionDialog,
    openResumeWithDirectory,
    closeNewSessionDialog,
    chooseNewSessionDirectory,
    confirmNewSessionDialog
  } = useNewSessionDialog({
    defaultCwd: DEFAULT_NEW_SESSION_CWD,
    selectedTarget,
    onCreate: ({ cwd, title, prompt, cliArgs }) => openNewSessionTab(targetId, cwd, title, prompt, cliArgs),
    onResume: (session, cwd) => openResumeSessionWithDirectory(session, cwd)
  });
  const {
    renameSession,
    renameDraft,
    setRenameDraft,
    renameError,
    setRenameError,
    renameBusy,
    openRenameSession,
    closeRenameSession,
    saveCustomSessionTitle,
    duplicateSession,
    duplicateDraft,
    setDuplicateDraft,
    duplicateError,
    setDuplicateError,
    duplicateBusy,
    openDuplicateSession,
    closeDuplicateSession,
    duplicateSelectedSession
  } = useSessionTitleDialogs({
    targetId,
    applyCustomTitle,
    applyDuplicatedSession: (duplicated) => {
      updateCachedSessions(targetId, "active", (current) => [
        duplicated,
        ...current.filter((item) => item.id !== duplicated.id)
      ]);
      setSelectedId(duplicated.id);
    },
    setNotice
  });
  const {
    vendorManagerOpen,
    setVendorManagerOpen,
    vendorManagerMode,
    setVendorManagerMode,
    vendors,
    vendorDraft,
    setVendorDraft,
    vendorBusy,
    vendorError,
    vendorFieldErrors,
    setVendorFieldErrors,
    vendorMessage,
    vendorToast,
    openVendorManager,
    editVendorDraft,
    changeVendorDraftProvider,
    saveVendorDraft,
    deleteVendorById,
    enableVendorById
  } = useVendors({
    selectedTarget,
    targetId,
    providerId,
    activeTerminalId: activeTabForSelectedTarget ? terminalIdsByTabKey[activeTabForSelectedTarget.key] : undefined
  });
  const {
    detailDialogSession,
    setDetailDialogSession,
    selectedSessionDetails,
    setSelectedSessionDetails,
    selectedSessionLoading,
    setSelectedSessionLoading,
    branchPanel,
    detailHasMore,
    detailLoadingMore,
    loadMoreDetailMessages,
    setBranchPanel,
    refreshSessionSnapshot,
    resetSessionDetails
  } = useSessionDetails({
    targetId,
    activeSession,
    view,
    supportsBranch: Boolean(capabilities?.branch),
    onSessionLoaded: applySessionSnapshot,
    notifyError: (message) => setNotice(message, undefined, "error")
  });
  const {
    deleteSessionById,
    restoreSessionById,
    purgeSessionById,
    deleteSelectedBatch,
    restoreSelectedBatch,
    purgeSelectedBatch
  } = createSessionActions({
    targetId,
    view,
    selectedBatchIds,
    selectedBatchSessions,
    activeViewLoaded,
    closeOpenSessionTerminal,
    updateCachedSessions,
    invalidateLoadedView,
    loadSessions,
    mergeSession,
    runWorkspaceAction,
    setSelectedId,
    setSelectedSessionDetails,
    setSelectedBatchIds,
    setNotice
  });
  const { branchFromTurn } = createSessionBranchActions({
    targetId,
    runWorkspaceAction,
    loadActiveSessions: () => loadSessions(targetId, "active", true),
    setBranchPanel,
    openDerivedSession,
    setError,
    setNotice,
    clearPendingTerminalTab
  });
  const { finalizeNewSession } = useNewSessionFinalizer({
    listAndCacheSessions: async (nextTargetId) => {
      const items = await window.codexConsole.listSessions(nextTargetId);
      const rendered = preserveOpenActiveSessions(items, nextTargetId);
      const activeCacheKey = sessionCacheKey(nextTargetId, "active");
      setSessionCache((current) => ({ ...current, [activeCacheKey]: rendered }));
      setLoadedViews((current) => ({ ...current, [activeCacheKey]: true }));
      return rendered;
    },
    applyCustomTitle: async (nextTargetId, sessionId, title) => {
      const metadata = await window.codexConsole.setSessionCustomTitle(nextTargetId, sessionId, title);
      applyCustomTitle(nextTargetId, sessionId, metadata);
    }
  });
  const activeSessionDetails = activeSession && selectedSessionDetails?.id === activeSession.id ? selectedSessionDetails : activeSession;
  const activeTitle = activeSession?.title || activeTab?.title || "当前无对话";
  const {
    compressionManagerOpen,
    setCompressionManagerOpen,
    compressionManagerMode,
    setCompressionManagerMode,
    compressionPrompts,
    compressionDraft,
    setCompressionDraft,
    compressionBusy,
    compressionError,
    compressionFieldErrors,
    setCompressionFieldErrors,
    compressionToast,
    openCompressionManager,
    editCompressionPromptDraft,
    saveCompressionPromptDraft,
    deleteCompressionPromptById,
    generateCompressionPrompt
  } = useCompressionPrompts({ getActiveSession: () => selectedSessionDetails || activeSession || selected });
  const {
    cliInstallerOpen,
    setCliInstallerOpen,
    cliInstallerBusy,
    cliInstallResult,
    cliInstallError,
    cliNodeMajor,
    setCliNodeMajor,
    cliEnvironmentByProvider,
    cliEnvironmentLoading,
    openCliInstallerDialog,
    refreshCliEnvironments,
    installAiCli
  } = useCliInstaller({ selectedTarget, targetId, providerId, setNotice, setError, loadTargets });
  const {
    skillManagerOpen,
    setSkillManagerOpen,
    skillView,
    skills,
    skillsLoading,
    openSkillManager,
    loadSkills,
    importSkillFromManager,
    toggleSkill,
    deleteInstalledSkill,
    restoreInstalledSkill,
    purgeInstalledSkill,
    switchSkillView
  } = useSkills({ targetId, setNotice, setError });
  const activeCwd = activeTabForSelectedTarget?.cwd || activeSessionForSelectedTarget?.cwd;
  const activeTerminalInputState = activeTab ? terminalInputStatesByTabKey[activeTab.key] : null;
  const canToggleTerminalInput = Boolean(activeTab && activeTerminalInputState?.composerVisible);
  const terminalInputButtonLabel = activeTerminalInputState?.mode === "composer" ? "终端输入" : "自管输入";
  const statusSession = activeSessionDetails;
  const statusUpdatedAt = statusSession ? formatDate(statusSession.updatedAt || statusSession.createdAt) : "-";
  const statusCwd = activeTab ? activeCwd || "~/.akim" : "-";
  const statusModel = formatModelStatus(statusSession);
  const statusTokenUsage = formatTokenUsage(statusSession);
  const statusContextUsage = formatContextUsage(statusSession);
  const statusContextLevel = getContextLevel(statusSession?.usage?.contextPercent);
  const supportsSkills = Boolean(capabilities?.skills);
  const supportsBranch = Boolean(capabilities?.branch);
  const supportsUsage = Boolean(capabilities?.usage);
  const supportsTrash = Boolean(capabilities?.trash);
  const supportsBatchActions = Boolean(capabilities?.batchActions);
  const supportsCustomCwd = Boolean(capabilities?.customCwd);
  const supportsExport = Boolean(capabilities?.export);
  const supportsSessionSettings = Boolean(capabilities?.sessionSettings);
  const supportsDuplicate = Boolean(capabilities?.duplicate);
  const supportsVendorManagement = Boolean(capabilities?.vendorManagement);
  const workspaceOverlayMessage =
    workspaceBusyMessage ||
    (sessionLoading ? "正在加载会话..." : "");

  useContextReminder({
    session: statusSession,
    setNotice,
    copyCompressionPrompt
  });

  useEffect(() => {
    if (view === "trash" && !supportsTrash) switchView("active");
    // 仅在能力/视图变化时纠正视图；switchView 每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsTrash, view]);

  useEffect(() => {
    if (!usageDetailsOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (usageDetailsRef.current?.contains(event.target as Node)) return;
      setUsageDetailsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUsageDetailsOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [usageDetailsOpen]);

  useEffect(() => {
    setUsageDetailsOpen(false);
  }, [statusSession?.id, supportsUsage]);

  useEffect(() => {
    if (!targetId) return;
    setSelectedId("");
    resetSessionDetails();
    // 目标切换只清理当前列表和详情状态；已打开终端保留其标签快照继续运行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  useEffect(() => {
    if (!contextMenu && !tabContextMenu) return;
    // 只在菜单外点击时关闭；菜单内点击必须先让“重命名/复制”等动作完成。
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // 两类菜单都在 document 下渲染；菜单内部点击不能先被全局监听卸载。
      if (target?.closest(".context-menu, .terminal-context-menu")) return;
      // 菜单卸载与弹框挂载之间存在一个事件循环；期间拖选弹框内容不应关闭任何浮层。
      if (target?.closest(".dialog-overlay, .terminal-paste-overlay")) return;
      setContextMenu(null);
      setTabContextMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [contextMenu, tabContextMenu]);

  function updateCachedSessions(
    nextTargetId: string,
    nextView: SessionView,
    updater: (sessions: AiSession[]) => AiSession[]
  ) {
    const nextCacheKey = sessionCacheKey(nextTargetId, nextView);
    setSessionCache((current) => ({
      ...current,
      [nextCacheKey]: updater(current[nextCacheKey] || [])
    }));
  }

  function preserveOpenActiveSessions(items: AiSession[], nextTargetId: string) {
    if (view !== "active") return items;

    const openSessions = openTabs
      .filter((tab) => tab.targetId === nextTargetId && tab.session)
      .map((tab) => tab.session as AiSession);
    const selectedSession =
      selectedSessionDetails && targetId === nextTargetId ? selectedSessionDetails : selected;
    const merged = openSessions.reduce((next, session) => mergeSession(next, session), items);
    return selectedSession && selectedSession.id
      ? mergeSession(merged, selectedSession)
      : merged;
  }

  function applySessionSnapshot(nextTargetId: string, session: AiSession) {
    updateCachedSessions(nextTargetId, "active", (current) => replaceCachedSession(current, session));
    updateCachedSessions(nextTargetId, "trash", (current) => replaceCachedSession(current, session));
    setOpenTabs((current) =>
      current.map((tab) =>
        tab.targetId === nextTargetId && tab.session?.id === session.id
          ? { ...tab, session, title: historyTabTitle(session) }
          : tab
      )
    );
  }

  function withCustomTitle(session: AiSession, metadata: AiSession["metadata"]): AiSession {
    const sourceTitle = session.sourceTitle || session.title;
    const hasMetadata = Boolean(metadata?.customTitle || metadata?.branch);
    return {
      ...session,
      title: metadata?.customTitle || sourceTitle,
      sourceTitle: metadata?.customTitle ? sourceTitle : undefined,
      metadata: hasMetadata ? metadata : undefined
    };
  }

  function applyCustomTitle(nextTargetId: string, sessionId: string, metadata: AiSession["metadata"]) {
    const rename = (session: AiSession) => (session.id === sessionId ? withCustomTitle(session, metadata) : session);
    updateCachedSessions(nextTargetId, "active", (current) => current.map(rename));
    updateCachedSessions(nextTargetId, "trash", (current) => current.map(rename));
    setOpenTabs((current) => current.map((tab) =>
      tab.targetId === nextTargetId && tab.session?.id === sessionId
        ? (() => {
            const session = withCustomTitle(tab.session, metadata);
            return { ...tab, session, title: historyTabTitle(session) };
          })()
        : tab
    ));
    setSelectedSessionDetails((current) => (current?.id === sessionId ? withCustomTitle(current, metadata) : current));
    setDetailDialogSession((current) => (current?.id === sessionId ? withCustomTitle(current, metadata) : current));
    setBranchPanel((current) => current
      ? {
          ...current,
          parent: current.parent?.id === sessionId ? withCustomTitle(current.parent, metadata) : current.parent,
          children: current.children.map(rename)
        }
      : current
    );
  }

  async function refreshCurrentView() {
    if (!targetId) {
      if (providerId) await loadTargets(providerId, { showLoading: true });
      return;
    }

    await loadSessions(targetId, view, true);
    const session = selectedSessionDetails || activeSession || selected;
    if (session) await refreshSessionSnapshot(targetId, session.id, session.filePath);
  }

  async function refreshProviderTargets() {
    if (!providerId) return;
    await loadTargets(providerId, { showLoading: true });
  }

  function invalidateLoadedView(nextTargetId: string, nextView: SessionView) {
    const nextCacheKey = sessionCacheKey(nextTargetId, nextView);
    setLoadedViews((current) => ({ ...current, [nextCacheKey]: false }));
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

    void openSessionTabWithCwdCheck(session);
  }

  async function openSessionTabWithCwdCheck(session: AiSession) {
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

  function openSessionDetail(session: AiSession) {
    setSelectedId(session.id);
    setDetailDialogSession(session);
    setError("");
    setNotice("");
  }

  function openSessionContextMenu(event: MouseEvent<HTMLElement>, session: AiSession) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      session,
      view
    });
  }

  function openNewSessionTab(
    nextTargetId = targetId,
    cwd = DEFAULT_NEW_SESSION_CWD,
    customTitle = "",
    prompt = "",
    cliArgs = ""
  ) {
    if (!nextTargetId) return;
    const index = newSessionIndex;
    const key = `new:${nextTargetId}:${Date.now()}:${index}`;
    const nextTarget = targets.find((target) => target.id === nextTargetId);
    const usesDefaultCwd = cwd === DEFAULT_NEW_SESSION_CWD;
    const displayTitle = customTitle.trim() || (index === 1 ? "新会话" : `新会话 ${index}`);
    setNewSessionIndex(index + 1);
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
    closeTerminalTabs([key]);
  }

  function closeOtherSessionTabs(key: string) {
    closeTerminalTabs(openTabs.filter((tab) => tab.key !== key).map((tab) => tab.key));
  }

  function closeAllSessionTabs() {
    closeTerminalTabs(openTabs.map((tab) => tab.key));
  }

  function handleTerminalInputState(tabKey: string, state: TerminalInputState) {
    setTerminalInputState(tabKey, state);
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
    const workspace = workspaceRef.current;
    const menuWidth = 132;
    // 菜单高度用于边界裁剪避免溢出窗口；值略大于实际菜单高度以留出余量。
    const menuHeight = 114;
    const gap = 8;
    const bounds = workspace?.getBoundingClientRect();
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

  function handleTerminalReady(tabKey: string, terminalId?: string) {
    registerTerminalReady(tabKey, terminalId);
    const tab = openTabs.find((item) => item.key === tabKey);
    if (tab?.customTitle) void finalizeNewSession(tab);
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

  async function closeOpenSessionTerminal(session: AiSession) {
    const key = tabKey(targetId, session.id);
    const terminalId = terminalIdsByTabKey[key];
    if (terminalId) await window.codexConsole.stopTerminal(terminalId);
    closeSessionTab(key);
  }

  async function runAppCommand(command: AppCommand) {
    try {
      await window.codexConsole.appCommand(command);
    } catch (commandError: any) {
      setError(commandError?.message || "菜单操作失败。");
    }
  }

  async function exportDiagnostics() {
    try {
      const result = await window.codexConsole.exportDiagnostics();
      setNotice(`诊断信息已导出：${result.filePath}`);
    } catch (diagnosticError: any) {
      setNotice(diagnosticError?.message || "导出诊断信息失败。", undefined, "error");
    }
  }

  async function exportActiveSession(format: SessionExportFormat) {
    if (!activeSession || !activeTab) return;

    await runWorkspaceAction("正在导出会话...", async () => {
      const result = await window.codexConsole.exportSession(activeTab.targetId, activeSession.id, format);
      if (result) setNotice(`会话已导出：${result.filePath}`);
    });
  }

  async function copyCompressionPrompt(sourceSession?: AiSession | null) {
    const session = sourceSession || selectedSessionDetails || activeSession || selected;
    const prompts = compressionPrompts.length > 0 ? compressionPrompts : await window.codexConsole.listCompressionPrompts();
    const prompt = prompts[0];
    if (!prompt) return;

    await window.codexConsole.copyText(renderCompressionPrompt(prompt.content, session));
    setNotice("压缩摘要提示词已复制。");
  }

  const appMenus = createAppMenus({
    supportsSkills,
    supportsSessionSettings,
    supportsExport,
    supportsVendorManagement,
    hasTarget: Boolean(targetId),
    isWslTarget: selectedTarget?.kind === "wsl",
    hasActiveSession: Boolean(activeSession),
    actions: {
      manageSkills: () => void openSkillManager(),
      openSessionSettings: openSessionSettingsDialog,
      openGatewayPortSettings: () => void openGatewayPortDialog(),
      exportSession: (format) => void exportActiveSession(format),
      quit: () => void runAppCommand("quit"),
      manageVendors: () => void openVendorManager(),
      manageCompressionPrompts: () => void openCompressionManager(),
      openSystemTerminal: openNewSystemTerminal,
      installCli: openCliInstallerDialog,
      exportDiagnostics: () => void exportDiagnostics(),
      openLogDirectory: () => void runAppCommand("openLogDir"),
      showAbout: () => void runAppCommand("about")
    }
  });

  return (
    <div className="app-frame">
      <AppMenuBar menus={appMenus} openMenu={openAppMenu} onOpenMenu={setOpenAppMenu} />
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar" hidden={sidebarCollapsed}>
        <SidebarHeader
          providers={providers}
          providerId={providerId}
          onProviderChange={setProviderId}
          targets={targets}
          targetId={targetId}
          onTargetChange={setTargetId}
          onOpenStatus={() => setProviderStatusOpen(true)}
          onRefresh={() => void refreshCurrentView()}
        />

        <SidebarControls
          view={view}
          supportsTrash={supportsTrash}
          onSwitchView={switchView}
          query={query}
          onQueryChange={setQuery}
          searchActive={Boolean(searchQuery)}
          searchLoading={searchLoading}
          resultCount={filtered.length}
          supportsBatchActions={supportsBatchActions}
          selectedCount={selectedBatchIds.length}
          allSelected={allVisibleSelected}
          onToggleAll={toggleAllVisibleSessions}
          onRestoreBatch={() => void restoreSelectedBatch()}
          onPurgeBatch={() => void purgeSelectedBatch()}
          onDeleteBatch={() => void deleteSelectedBatch()}
        />

        <SessionList
          sessions={filtered}
          loading={sessionLoading || searchLoading}
          emptyMessage={searchQuery ? "未找到匹配会话。" : view === "trash" ? "回收站为空。" : "未找到会话。"}
          activeSessionId={activeSessionForSelectedTarget?.id}
          selectedId={selected?.id}
          selectedBatchIds={selectedBatchIds}
          onContextMenu={handleSessionContextMenu}
          onToggleBatch={handleToggleBatchSelection}
          onOpen={handleOpenSessionTab}
        />
      </aside>
      <section className="workspace">
        {error && <div className="error-banner">{error}</div>}

        <TerminalWorkspace
          workspaceRef={workspaceRef}
          sidebarCollapsed={sidebarCollapsed}
          activeTitle={activeTitle}
          activeSession={activeSessionForSelectedTarget}
          providerId={providerId}
          targetId={targetId}
          onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
          onOpenDetail={openSessionDetail}
          onOpenNewSession={openNewSessionDialog}
          tabs={openTabs}
          activeTabKey={activeTabKey}
          tabsRef={terminalTabsRef}
          onTabsWheel={handleTerminalTabsWheel}
          onSelectTab={(tabKey, sessionId) => {
            setActiveTabKey(tabKey);
            setSelectedId(sessionId);
          }}
          onTabContextMenu={openTerminalTabContextMenu}
          onCloseTab={closeSessionTab}
          focusRequest={workspaceFocusRequest}
          terminalInputStates={terminalInputStatesByTabKey}
          onTerminalReady={handleTerminalReady}
          onTerminalExit={handleTerminalExit}
          onTerminalInputState={handleTerminalInputState}
          systemTerminalOpen={systemTerminalOpen}
          activeCwd={activeCwd}
          systemTerminalMinimized={systemTerminalMinimized}
          systemTerminalCreateSignal={systemTerminalCreateSignal}
          onCloseSystemTerminal={closeSystemTerminal}
          onToggleSystemTerminalMinimized={toggleSystemTerminalMinimized}
          vendors={vendors}
        />

        {detailDialogSession && (
          <SessionDetailModal
            session={detailDialogSession}
            selectedSessionDetails={selectedSessionDetails}
            loading={selectedSessionLoading}
            branchPanel={branchPanel}
            hasMore={detailHasMore}
            loadingMore={detailLoadingMore}
            onLoadMore={loadMoreDetailMessages}
            supportsBranch={supportsBranch}
            onClose={() => setDetailDialogSession(null)}
            onOpenSession={openSessionDetail}
            onBranchFromTurn={(session, turn) => void branchFromTurn(session, turn)}
          />
        )}

        {contextMenu && (
          <SessionContextMenu
            menu={contextMenu}
            supportsTrash={supportsTrash}
            canDuplicate={contextMenu.view === "active" && supportsDuplicate}
            onRename={() => {
              const session = contextMenu.session;
              setContextMenu(null);
              // 先卸载右键菜单，再挂载弹框，避免全局 pointerdown 监听误关弹框。
              window.setTimeout(() => openRenameSession(session), 0);
            }}
            onDuplicate={() => {
              const session = contextMenu.session;
              setContextMenu(null);
              window.setTimeout(() => openDuplicateSession(session), 0);
            }}
            onOpenFolder={() =>
              void runWorkspaceAction("正在打开目录...", () =>
                window.codexConsole.openSessionFolder(targetId, contextMenu.session.id)
              )
            }
            onRestore={() => void restoreSessionById(contextMenu.session)}
            onPurge={() => void purgeSessionById(contextMenu.session)}
            onDelete={() => void deleteSessionById(contextMenu.session)}
            onClose={() => setContextMenu(null)}
          />
        )}

        {tabContextMenu && (
          <TabContextMenu
            menu={tabContextMenu}
            canCloseOthers={openTabs.length > 1}
            canCloseAll={openTabs.length > 0}
            onCloseTab={() => closeSessionTab(tabContextMenu.tabKey)}
            onCloseOthers={() => closeOtherSessionTabs(tabContextMenu.tabKey)}
            onCloseAll={() => closeAllSessionTabs()}
            onDismiss={() => setTabContextMenu(null)}
          />
        )}

      </section>
      <StatusBar
        session={statusSession}
        updatedAt={statusUpdatedAt}
        cwd={statusCwd}
        model={statusModel}
        tokenUsage={statusTokenUsage}
        contextUsage={statusContextUsage}
        contextLevel={statusContextLevel}
        supportsUsage={supportsUsage}
        usageDetailsOpen={usageDetailsOpen}
        usageDetailsRef={usageDetailsRef}
        onToggleUsageDetails={() => setUsageDetailsOpen((open) => !open)}
        terminalInputMode={activeTerminalInputState?.mode}
        terminalInputButtonLabel={terminalInputButtonLabel}
        canToggleTerminalInput={canToggleTerminalInput}
        onToggleTerminalInputMode={toggleActiveTerminalInputMode}
      />
      {notice && <NoticeToast notice={notice} onDismiss={() => setNotice("")} />}
      {providerStatusOpen && (
        <ProviderStatusDialog
          provider={selectedProvider}
          target={selectedTarget}
          targetCount={targets.length}
          onClose={() => setProviderStatusOpen(false)}
          onRescan={() => void refreshProviderTargets()}
          onRefresh={() => void refreshCurrentView()}
        />
      )}
      {cliInstallerOpen && (
        <CliInstallerDialog
          busy={cliInstallerBusy}
          environments={cliEnvironmentByProvider}
          environmentLoading={cliEnvironmentLoading}
          nodeMajor={cliNodeMajor}
          result={cliInstallResult}
          error={cliInstallError}
          target={selectedTarget}
          onNodeMajorChange={setCliNodeMajor}
          onRefresh={refreshCliEnvironments}
          onClose={() => setCliInstallerOpen(false)}
          onInstall={installAiCli}
        />
      )}
      {compressionManagerOpen && (
        <CompressionPromptManagerDialog
          prompts={compressionPrompts}
          draft={compressionDraft}
          mode={compressionManagerMode}
          busy={compressionBusy}
          error={compressionError}
          fieldErrors={compressionFieldErrors}
          toast={compressionToast}
          onDraftChange={setCompressionDraft}
          onFieldErrorClear={(field) => setCompressionFieldErrors((current) => ({ ...current, [field]: undefined }))}
          onNew={() => editCompressionPromptDraft()}
          onEdit={editCompressionPromptDraft}
          onGenerate={(prompt) => void generateCompressionPrompt(prompt)}
          onSave={() => void saveCompressionPromptDraft()}
          onDelete={(promptId) => void deleteCompressionPromptById(promptId)}
          onBack={() => setCompressionManagerMode("list")}
          onClose={() => setCompressionManagerOpen(false)}
        />
      )}
      {vendorManagerOpen && (
        <VendorManagerDialog
          vendors={vendors}
          draft={vendorDraft}
          mode={vendorManagerMode}
          busy={vendorBusy}
          error={vendorError}
          fieldErrors={vendorFieldErrors}
          message={vendorMessage}
          toast={vendorToast}
          target={selectedTarget}
          onDraftChange={setVendorDraft}
          onFieldErrorClear={(field) => setVendorFieldErrors((current) => ({ ...current, [field]: undefined }))}
          onNew={() => void editVendorDraft()}
          onEdit={(vendor) => void editVendorDraft(vendor)}
          onProviderChange={(nextProviderId) => void changeVendorDraftProvider(nextProviderId)}
          onSave={() => void saveVendorDraft()}
          onDelete={(vendorId) => void deleteVendorById(vendorId)}
          onEnable={(vendorId) => void enableVendorById(vendorId)}
          onBack={() => setVendorManagerMode("list")}
          onClose={() => setVendorManagerOpen(false)}
        />
      )}
      {newSessionDialogOpen && (
        <NewSessionDialog
          pendingResume={pendingResumeSession}
          supportsCustomCwd={supportsCustomCwd}
          cwd={newSessionCwd}
          title={newSessionTitle}
          prompt={newSessionPrompt}
          cliArgs={newSessionCliArgs}
          onChooseDirectory={() => void chooseNewSessionDirectory()}
          onTitleChange={setNewSessionTitle}
          onPromptChange={setNewSessionPrompt}
          onCliArgsChange={setNewSessionCliArgs}
          onClose={closeNewSessionDialog}
          onConfirm={confirmNewSessionDialog}
        />
      )}
      {sessionSettingsOpen && (
        <SessionSettingsDialog
          wslPath={wslPathDraft}
          isWsl={selectedTarget?.kind === "wsl"}
          supportsSessionSettings={supportsSessionSettings}
          onChange={setWslPathDraft}
          onClose={() => setSessionSettingsOpen(false)}
          onRestore={() => void clearWslCodexHome()}
          onSave={() => void configureWslCodexHome()}
        />
      )}
      {gatewayPortOpen && (
        <GatewayPortDialog
          draft={gatewayPortDraft}
          status={gatewayPortStatus}
          error={gatewayPortError}
          busy={gatewayPortBusy}
          onChange={setGatewayPortDraft}
          onClose={() => setGatewayPortOpen(false)}
          onSave={() => void saveGatewayPort()}
        />
      )}
      {skillManagerOpen && (
        <SkillManagerDialog
          skills={skills}
          skillView={skillView}
          skillsLoading={skillsLoading}
          targetId={targetId}
          targetLabel={selectedTarget?.label || ""}
          onClose={() => setSkillManagerOpen(false)}
          onSwitchView={(view) => void switchSkillView(view)}
          onRefresh={() => void loadSkills()}
          onImport={() => void importSkillFromManager()}
          onToggle={(skill) => void toggleSkill(skill)}
          onDelete={(skill) => void deleteInstalledSkill(skill)}
          onRestore={(skill) => void restoreInstalledSkill(skill)}
          onPurge={(skill) => void purgeInstalledSkill(skill)}
        />
      )}

      <AppPortalLayer
        rename={{
          session: renameSession,
          value: renameDraft,
          error: renameError,
          busy: renameBusy,
          onChange: (value) => {
            setRenameDraft(value);
            if (renameError) setRenameError("");
          },
          onClose: closeRenameSession,
          onRestore: () => void saveCustomSessionTitle(""),
          onSave: () => void saveCustomSessionTitle()
        }}
        duplicate={{
          session: duplicateSession,
          value: duplicateDraft,
          error: duplicateError,
          busy: duplicateBusy,
          onChange: (value) => {
            setDuplicateDraft(value);
            if (duplicateError) setDuplicateError("");
          },
          onClose: closeDuplicateSession,
          onSave: () => void duplicateSelectedSession()
        }}
        workspaceMessage={workspaceOverlayMessage}
      />
	    </main>
    </div>
	  );
	}

function getContextLevel(percent?: number) {
  if (typeof percent !== "number") return "unknown";
  if (percent >= 90) return "danger";
  if (percent >= 80) return "warning";
  if (percent >= 60) return "notice";
  return "ok";
}

function logPerformance(label: string, durationMs: number, status?: string) {
  return window.codexConsole.logPerformance(label, durationMs, status);
}

const DEFAULT_NEW_SESSION_CWD = "~/.akim";

function focusActiveWorkspaceInput(workspace: HTMLElement | null) {
  const activePanel = workspace?.querySelector<HTMLElement>(".terminal-panel.active");
  const target =
    activePanel?.querySelector<HTMLTextAreaElement>(".terminal-composer textarea") ||
    activePanel?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ||
    activePanel?.querySelector<HTMLElement>(".terminal-host .xterm");
  target?.focus();
}

function historyTabTitle(session: AiSession) {
  return session.metadata?.customTitle?.trim() || session.id;
}
