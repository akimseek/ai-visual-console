import { useEffect, useRef, useState } from "react";
import type {
  AiSession,
  SessionExportFormat
} from "../types";
import { formatDate } from "../lib/format";
import {
  formatContextUsage,
  formatModelStatus,
  formatTokenUsage,
  mergeSession
} from "../features/sessions/session-format";
import { useTabVendors } from "../features/vendors/use-tab-vendors";
import { AppMenuBar } from "./app-menu-bar";
import { CommandPalette } from "./command-palette";
import { useVendors } from "../features/vendors/use-vendors";
import { useCompressionPrompts } from "../features/settings/use-compression-prompts";
import { useCliInstaller } from "../hooks/use-cli-installer";
import { useSkills } from "../features/skills/use-skills";
import { useGatewayPortDialog } from "../features/settings/use-gateway-port-dialog";
import { StatusBar } from "../components/status-bar";
import { SessionList } from "../features/sessions/session-list";
import { useStableCallback } from "../hooks/use-stable-callback";
import { SidebarControls } from "../components/sidebar-controls";
import { NoticeToast } from "../components/notice-toast";
import { SidebarHeader } from "../components/sidebar-header";
import { renderCompressionPrompt } from "../features/settings/compression-prompt";
import { sessionCacheKey, useSessionLoader, type SessionView } from "../features/sessions/use-session-loader";
import { useSessionWorkspaceState } from "../features/sessions/use-session-workspace-state";
import { useAppMenuState } from "../hooks/use-app-menu-state";
import { useProviderTargets } from "../hooks/use-provider-targets";
import { useSessionTitleDialogs } from "../features/sessions/use-session-title-dialogs";
import { useTerminalTabs } from "../features/terminal/use-terminal-tabs";
import { useNewSessionDialog } from "../hooks/use-new-session-dialog";
import { createSessionActions } from "../features/sessions/use-session-actions";
import { useSessionDetails } from "../features/sessions/use-session-details";
import { useSessionCacheOperations } from "../features/sessions/use-session-cache-operations";
import { DEFAULT_NEW_SESSION_CWD, useSessionTabs } from "../features/sessions/use-session-tabs";
import { useSessionListState } from "../features/sessions/use-session-list-state";
import { useAppNotice } from "../hooks/use-app-notice";
import { useWorkspaceAction } from "../hooks/use-workspace-action";
import { useContextReminder } from "../hooks/use-context-reminder";
import { useSystemTerminal } from "../features/terminal/use-system-terminal";
import { createAppMenus } from "./app-menus";
import { useSessionSettings } from "../features/sessions/use-session-settings";
import { createSessionBranchActions } from "../features/sessions/create-session-branch-actions";
import { useNewSessionFinalizer } from "../features/sessions/new-session-finalizer";
import { AppPortalLayer } from "./app-portal-layer";
import { TerminalWorkspace, type TerminalInputState } from "../features/terminal/terminal-workspace";
import { useWorkspaceSessionActions } from "../features/sessions/use-workspace-session-actions";
import { WorkspaceOverlays, type SessionContextMenuState, type TabContextMenuState } from './workspace-overlays'
import { useAppCommands } from "../hooks/use-app-commands";
import { ProviderStatusOverlay } from './provider-status-overlay'
import { CliInstallerOverlay } from './cli-installer-overlay'
import { GatewayPortOverlay } from './gateway-port-overlay'
import { SessionOverlays } from './session-overlays'
import { VendorManagerOverlay } from './vendor-manager-overlay'
import { CompressionPromptOverlay } from './compression-prompt-overlay'
import { SkillManagerOverlay } from './skill-manager-overlay'
import { SidebarWorkbench } from "../features/workbench/workbench-view";
export function App() {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState("");
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const terminalTabsRef = useRef<HTMLDivElement | null>(null);
  const [providerStatusOpen, setProviderStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const { openAppMenu, setOpenAppMenu } = useAppMenuState();
  const usageDetailsRef = useRef<HTMLDivElement | null>(null);

  const { notice, setNotice } = useAppNotice();
  const executeAppCommand = useAppCommands(setError);

  const gatewayPort = useGatewayPortDialog({ setNotice });
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
    providers,
    providerId,
    setProviderId,
    targets,
    targetId,
    setTargetId,
    loadTargets
  } = useProviderTargets({ setError, logPerformance });

  const {
    view,
    setView,
    setSessionCache,
    loadedViews,
    setLoadedViews,
    setSelectedId,
    sessionLoading,
    setSessionLoading,
    cacheKey,
    sessions,
    selected,
    activeViewLoaded
  } = useSessionWorkspaceState({ targetId });

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
    markTerminalExited,
    clearPendingTerminalTab
  } = useTerminalTabs({ setSelectedId });
  const activeTab = openTabs.find((tab) => tab.key === activeTabKey) || openTabs[0] || null;
  const activeSession = activeTab?.session || null;

  useEffect(() => {
    void logPerformance("renderer.mounted", performance.now());
  }, []);
    // 仅在目标/视图/缓存键变化时加载；loadSessions 每渲染重建
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
  const {
    query,
    setQuery,
    searchQuery,
    filtered,
    searchLoading,
    selectedBatchIds,
    setSelectedBatchIds,
    selectedBatchSessions,
    allVisibleSelected,
    toggleBatchSelection,
    toggleAllVisibleSessions
  } = useSessionListState({
    targetId,
    view,
    cacheKey,
    sessions,
    loadedViews,
    loadSessions,
    setError
  });
  // 传给已 memo 的 SessionList 的稳定回调：身份恒定，避免父级重渲染时让 memo 失效；
  // 内部仍调用最新的处理函数实现（这些 function 声明已提升，可在此引用）。
  const handleToggleBatchSelection = useStableCallback(toggleBatchSelection);

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
    loadApiVendors,
    openVendorManager,
    editVendorDraft,
    changeVendorDraftProvider,
    saveVendorDraft,
    deleteVendorById,
    setVendorEnabledById,
    refreshVendorBalanceById,
    refreshAllVendorBalances,
    refreshingVendorIds,
    refreshingAllBalances
  } = useVendors({
    selectedTarget,
    targetId,
    providerId,
  });
  // 供应商名称用于底部状态栏和网关切换提示；目标切换时轻量读取一次，避免必须先打开管理弹框。
  useEffect(() => {
    if (targetId) void loadApiVendors(false);
    // loadApiVendors 随 Hook 每次渲染重建，这里只需随目标切换触发一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);
  // 已有终端路由时只展示该路由的供应商；找不到名称也显示占位符，不能回退到候选池首项造成误导。
  const { activeVendorId, activeVendorName, activeVendorSwitch, bindTabVendor, releaseTabVendor, handleVendorSwitch } = useTabVendors({
    vendors,
    loadApiVendors,
    setNotice,
    activeTabKey: activeTab?.key,
    providerId,
    selectedTarget
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
    notifyError: (message) => setNotice(message, undefined, "error")
  });
  const sessionCacheOperations = useSessionCacheOperations({
    setSessionCache,
    setOpenTabs,
    setSelectedSessionDetails,
    setDetailDialogSession,
    setBranchPanel
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
      sessionCacheOperations.applyCustomTitle(nextTargetId, sessionId, metadata);
    }
  });
  const sessionTabs = useSessionTabs({
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
    onCreate: ({ cwd, title, prompt, cliArgs }) => sessionTabs.openNewSessionTab(targetId, cwd, title, prompt, cliArgs),
    onResume: (session, cwd) => sessionTabs.openResumeSessionWithDirectory(session, cwd)
  });
  const activeTerminalInputState = activeTab ? terminalInputStatesByTabKey[activeTab.key] : null;
  const canToggleTerminalInput = Boolean(activeTab && activeTerminalInputState?.composerVisible);

  useEffect(() => {
    const openCommandPalette = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      // 终端原生输入保留 Ctrl+K，避免命令面板拦截 CLI 自身的快捷键。
      if (activeTerminalInputState?.mode === "terminal") return;
      event.preventDefault();
      setOpenAppMenu("");
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", openCommandPalette);
    return () => window.removeEventListener("keydown", openCommandPalette);
  }, [activeTerminalInputState?.mode, setOpenAppMenu]);
  const workspaceActions = useWorkspaceSessionActions({
    workspaceRef,
    terminalTabsRef,
    view,
    targetId,
    providerId,
    supportsTrash: Boolean(capabilities?.trash),
    activeTab,
    activeTerminalInputState,
    canToggleTerminalInput,
    openSessionTabWithCwdCheck: sessionTabs.openSessionTabWithCwdCheck,
    selectedSession: selected,
    activeSession,
    selectedSessionDetails,
    applySessionSnapshot: sessionCacheOperations.applySessionSnapshot,
    loadSessions,
    loadTargets,
    refreshSessionSnapshot,
    invalidateLoadedView,
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
  });
  const handleSessionContextMenu = useStableCallback(workspaceActions.openSessionContextMenu);
  const handleOpenSessionTab = useStableCallback(workspaceActions.openSessionTab);
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
    applyCustomTitle: sessionCacheOperations.applyCustomTitle,
    applyDuplicatedSession: (duplicated) => {
      sessionCacheOperations.updateCachedSessions(targetId, "active", (current) => [
        duplicated,
        ...current.filter((item) => item.id !== duplicated.id)
      ]);
      setSelectedId(duplicated.id);
    },
    setNotice
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
    closeOpenSessionTerminal: sessionTabs.closeOpenSessionTerminal,
    updateCachedSessions: sessionCacheOperations.updateCachedSessions,
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
    openDerivedSession: sessionTabs.openDerivedSession,
    setError,
    setNotice,
    clearPendingTerminalTab
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
    if (view === "trash" && !supportsTrash) workspaceActions.switchView("active");
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

  function invalidateLoadedView(nextTargetId: string, nextView: SessionView) {
    const nextCacheKey = sessionCacheKey(nextTargetId, nextView);
    setLoadedViews((current) => ({ ...current, [nextCacheKey]: false }));
  }

  function handleTerminalInputState(tabKey: string, state: TerminalInputState) {
    setTerminalInputState(tabKey, state);
  }

  function handleTerminalReady(tabKey: string, terminalId?: string, vendorId?: string) {
    registerTerminalReady(tabKey, terminalId);
    bindTabVendor(tabKey, vendorId);
    const tab = openTabs.find((item) => item.key === tabKey);
    if (tab?.customTitle) void finalizeNewSession(tab);
  }

  function handleTerminalExit(tabKey: string, exitCode: number) {
    markTerminalExited(tabKey);
    sessionTabs.handleTerminalExit(tabKey, exitCode);
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
      openCommandPalette: () => {
        setOpenAppMenu("");
        setCommandPaletteOpen(true);
      },
      manageSkills: () => void openSkillManager(),
      openSessionSettings: openSessionSettingsDialog,
      openGatewayPortSettings: () => void gatewayPort.openGatewayPortDialog(),
      exportSession: (format) => void exportActiveSession(format),
      quit: () => void executeAppCommand("quit"),
      manageVendors: () => void openVendorManager(),
      manageCompressionPrompts: () => void openCompressionManager(),
      openSystemTerminal: openNewSystemTerminal,
      installCli: openCliInstallerDialog,
      exportDiagnostics: () => void exportDiagnostics(),
      openLogDirectory: () => void executeAppCommand("openLogDir"),
      showAbout: () => void executeAppCommand("about")
    }
  });

  return (
    <div className="app-frame">
      <AppMenuBar
        menus={appMenus}
        openMenu={openAppMenu}
        onOpenMenu={setOpenAppMenu}
      />
      <CommandPalette menus={appMenus} open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
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
          onRefresh={() => void workspaceActions.refreshCurrentView()}
        />

        <SidebarControls
          workbenchOpen={workbenchOpen}
          onOpenWorkbench={() => setWorkbenchOpen(true)}
          view={view}
          supportsTrash={supportsTrash}
          onSwitchView={(nextView) => {
            setWorkbenchOpen(false);
            workspaceActions.switchView(nextView);
          }}
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

        {workbenchOpen ? (
          <SidebarWorkbench
            provider={selectedProvider}
            target={selectedTarget}
            vendors={vendors}
            activeVendorId={activeVendorId}
            activeVendorName={activeVendorName}
            lastVendorSwitch={activeVendorSwitch}
            session={statusSession}
            model={statusModel}
            tokenUsage={statusTokenUsage}
            contextUsage={statusContextUsage}
          />
        ) : <SessionList
          sessions={filtered}
          loading={sessionLoading || searchLoading}
          emptyMessage={searchQuery ? "未找到匹配会话。" : view === "trash" ? "回收站为空。" : "未找到会话。"}
          activeSessionId={activeSessionForSelectedTarget?.id}
          selectedId={selected?.id}
          selectedBatchIds={selectedBatchIds}
          onContextMenu={handleSessionContextMenu}
          onToggleBatch={handleToggleBatchSelection}
          onOpen={handleOpenSessionTab}
        />}
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
          onOpenDetail={workspaceActions.openSessionDetail}
          onOpenNewSession={openNewSessionDialog}
          tabs={openTabs}
          activeTabKey={activeTabKey}
          tabsRef={terminalTabsRef}
          onTabsWheel={workspaceActions.handleTerminalTabsWheel}
          onSelectTab={(tabKey, sessionId) => {
            setActiveTabKey(tabKey);
            setSelectedId(sessionId);
          }}
          onTabContextMenu={workspaceActions.openTerminalTabContextMenu}
          onCloseTab={sessionTabs.closeSessionTab}
          focusRequest={workspaceFocusRequest}
          terminalInputStates={terminalInputStatesByTabKey}
          onTerminalReady={handleTerminalReady}
          onVendorSwitch={handleVendorSwitch}
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

        <WorkspaceOverlays
          detailDialogSession={detailDialogSession}
          selectedSessionDetails={selectedSessionDetails}
          selectedSessionLoading={selectedSessionLoading}
          branchPanel={branchPanel}
          detailHasMore={detailHasMore}
          detailLoadingMore={detailLoadingMore}
          supportsBranch={supportsBranch}
          onLoadMore={loadMoreDetailMessages}
          onCloseDetail={() => setDetailDialogSession(null)}
          onOpenSession={workspaceActions.openSessionDetail}
          onBranchFromTurn={(session, turn) => void branchFromTurn(session, turn)}
          contextMenu={contextMenu}
          supportsTrash={supportsTrash}
          supportsDuplicate={supportsDuplicate}
          onRename={(session) => {
            setContextMenu(null);
            window.setTimeout(() => openRenameSession(session), 0);
          }}
          onDuplicate={(session) => {
            setContextMenu(null);
            window.setTimeout(() => openDuplicateSession(session), 0);
          }}
           onOpenFolder={(session) => void runWorkspaceAction('正在打开目录...', () =>
             window.codexConsole.openSessionFolder(targetId, session.id)
           )}
          onRestore={(session) => void restoreSessionById(session)}
          onPurge={(session) => void purgeSessionById(session)}
          onDelete={(session) => void deleteSessionById(session)}
          onCloseContextMenu={() => setContextMenu(null)}
          tabContextMenu={tabContextMenu}
          tabCount={openTabs.length}
          onCloseTab={sessionTabs.closeSessionTab}
          onCloseOtherTabs={sessionTabs.closeOtherSessionTabs}
          onCloseAllTabs={sessionTabs.closeAllSessionTabs}
          onCloseTabContextMenu={() => setTabContextMenu(null)}
        />
      </section>
      <StatusBar
        session={statusSession}
        updatedAt={statusUpdatedAt}
        cwd={statusCwd}
        vendorName={activeVendorName}
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
        onToggleTerminalInputMode={workspaceActions.toggleActiveTerminalInputMode}
      />
      {notice && <NoticeToast notice={notice} onDismiss={() => setNotice("")} />}
      <ProviderStatusOverlay
        open={providerStatusOpen}
        provider={selectedProvider}
        target={selectedTarget}
        targetCount={targets.length}
        onClose={() => setProviderStatusOpen(false)}
        onRescan={() => void workspaceActions.refreshProviderTargets()}
        onRefresh={() => void workspaceActions.refreshCurrentView()}
      />
      <CliInstallerOverlay
        open={cliInstallerOpen}
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
      <CompressionPromptOverlay
        open={compressionManagerOpen}
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
      <VendorManagerOverlay
        open={vendorManagerOpen}
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
        onToggleEnabled={(vendorId, enabled) => void setVendorEnabledById(vendorId, enabled)}
        onRefreshBalance={(vendorId) => void refreshVendorBalanceById(vendorId)}
        onRefreshAllBalances={() => void refreshAllVendorBalances()}
        refreshingVendorIds={refreshingVendorIds}
        refreshingAllBalances={refreshingAllBalances}
        onBack={() => setVendorManagerMode("list")}
        onClose={() => setVendorManagerOpen(false)}
      />
      <SessionOverlays
        newSessionOpen={newSessionDialogOpen}
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
        onCloseNewSession={closeNewSessionDialog}
        onConfirmNewSession={confirmNewSessionDialog}
        settingsOpen={sessionSettingsOpen}
        target={selectedTarget}
        wslPath={wslPathDraft}
        supportsSessionSettings={supportsSessionSettings}
        onWslPathChange={setWslPathDraft}
        onCloseSettings={() => setSessionSettingsOpen(false)}
        onRestoreWslPath={() => void clearWslCodexHome()}
        onSaveWslPath={() => void configureWslCodexHome()}
      />
      <GatewayPortOverlay
        open={gatewayPort.open}
        draft={gatewayPort.portDraft}
        failureThresholdDraft={gatewayPort.failureThresholdDraft}
        circuitFailureThresholdDraft={gatewayPort.circuitFailureThresholdDraft}
        circuitDurationDraft={gatewayPort.circuitDurationDraft}
        status={gatewayPort.status}
        error={gatewayPort.error}
        busy={gatewayPort.busy}
        onChange={gatewayPort.setPortDraft}
        onFailureThresholdChange={gatewayPort.setFailureThresholdDraft}
        onCircuitFailureThresholdChange={gatewayPort.setCircuitFailureThresholdDraft}
        onCircuitDurationChange={gatewayPort.setCircuitDurationDraft}
        onClose={() => gatewayPort.setOpen(false)}
        onSave={() => void gatewayPort.saveGatewayPort()}
      />
      <SkillManagerOverlay
        open={skillManagerOpen}
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

function focusActiveWorkspaceInput(workspace: HTMLElement | null) {
  const activePanel = workspace?.querySelector<HTMLElement>(".terminal-panel.active");
  const target =
    activePanel?.querySelector<HTMLTextAreaElement>(".terminal-composer textarea") ||
    activePanel?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ||
    activePanel?.querySelector<HTMLElement>(".terminal-host .xterm");
  target?.focus();
}
