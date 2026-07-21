import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import type {
  AiProviderId,
  AiProviderSummary,
  AiSession,
  AiTarget,
  AppCommand,
  SessionExportFormat
} from "./types";
import { formatDate } from "./format";
import {
  formatCompactNumber,
  formatContextUsage,
  formatModelStatus,
  formatTokenUsage,
  localFilterSessions,
  mergeSession,
  replaceCachedSession,
  shortSessionId,
  tabKey
} from "./sessionFormat";
import { ProviderStatusDialog } from "./ProviderStatusDialog";
import type { BranchPanelState } from "./BranchPanel";
import { CliInstallerDialog } from "./CliInstallerDialog";
import { CompressionPromptManagerDialog } from "./CompressionPromptManagerDialog";
import { VendorManagerDialog } from "./VendorManagerDialog";
import { AppMenuBar } from "./AppMenuBar";
import type { AppMenuDefinition } from "./AppMenuBar";
import { useVendors } from "./useVendors";
import { useCompressionPrompts } from "./useCompressionPrompts";
import { useCliInstaller } from "./useCliInstaller";
import { useSkills } from "./useSkills";
import { SkillManagerDialog } from "./SkillManagerDialog";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionSettingsDialog } from "./SessionSettingsDialog";
import { SessionDetailModal } from "./SessionDetailModal";
import { SessionRenameDialog } from "./SessionRenameDialog";
import { SessionContextMenu, TabContextMenu } from "./ContextMenus";
import { StatusBar } from "./StatusBar";
import { SessionList } from "./SessionList";
import { useStableCallback } from "./useStableCallback";
import { SidebarControls } from "./SidebarControls";
import { NoticeToast } from "./NoticeToast";
import { TerminalTabs } from "./TerminalTabs";
import { SidebarHeader } from "./SidebarHeader";
import type { ConversationTurn } from "./conversation";
import { renderCompressionPrompt } from "./compressionPrompt";

const EmbeddedTerminal = lazy(() =>
  import("./EmbeddedTerminal").then((module) => ({ default: module.EmbeddedTerminal }))
);
const SystemTerminal = lazy(() =>
  import("./SystemTerminal").then((module) => ({ default: module.SystemTerminal }))
);

type TerminalTab = {
  key: string;
  targetId: string;
  session?: AiSession;
  title: string;
  cwd?: string;
  useCodexCwdFlag?: boolean;
  prompt?: string;
  cliArgs?: string;
  customTitle?: string;
  knownSessionIds?: string[];
  createdAt?: number;
};

type TerminalInputState = {
  mode: "composer" | "terminal";
  composerVisible: boolean;
};

type PendingResumeSession = {
  session: AiSession;
  missingCwd: string;
};

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

type SessionView = "active" | "trash";
type SessionCacheKey = `${string}:${SessionView}`;
type SearchState = {
  key: SessionCacheKey;
  query: string;
  sessions: AiSession[];
  loading: boolean;
};
type NoticeState = {
  message: string;
  tone?: "success" | "error";
  actionLabel?: string;
  onAction?: () => void;
};

export function App() {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [providers, setProviders] = useState<AiProviderSummary[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId | "">("");
  const [targets, setTargets] = useState<AiTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [view, setView] = useState<SessionView>("active");
  const [sessionCache, setSessionCache] = useState<Record<SessionCacheKey, AiSession[]>>({});
  const [loadedViews, setLoadedViews] = useState<Record<SessionCacheKey, boolean>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNoticeState] = useState<NoticeState | null>(null);
  const [wslPathDraft, setWslPathDraft] = useState("");
  const [openTabs, setOpenTabs] = useState<TerminalTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [newSessionIndex, setNewSessionIndex] = useState(1);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [detailDialogSession, setDetailDialogSession] = useState<AiSession | null>(null);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<AiSession | null>(null);
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const [pendingTerminalTabKey, setPendingTerminalTabKey] = useState("");
  const [terminalIdsByTabKey, setTerminalIdsByTabKey] = useState<Record<string, string>>({});
  const [terminalInputStatesByTabKey, setTerminalInputStatesByTabKey] = useState<Record<string, TerminalInputState>>({});
  const terminalTabsRef = useRef<HTMLDivElement | null>(null);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionCwd, setNewSessionCwd] = useState(DEFAULT_NEW_SESSION_CWD);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionPrompt, setNewSessionPrompt] = useState("");
  const [newSessionCliArgs, setNewSessionCliArgs] = useState("");
  const [pendingResumeSession, setPendingResumeSession] = useState<PendingResumeSession | null>(null);
  const [renameSession, setRenameSession] = useState<AiSession | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [providerStatusOpen, setProviderStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const [branchPanel, setBranchPanel] = useState<BranchPanelState | null>(null);
  const [workspaceBusyMessage, setWorkspaceBusyMessage] = useState("");
  const [workspaceFocusRequest, setWorkspaceFocusRequest] = useState(0);
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  const [openAppMenu, setOpenAppMenu] = useState("");
  const [systemTerminalOpen, setSystemTerminalOpen] = useState(false);
  const [systemTerminalMinimized, setSystemTerminalMinimized] = useState(false);
  const [systemTerminalCreateSignal, setSystemTerminalCreateSignal] = useState(0);
  const contextReminderKeys = useRef(new Set<string>());
  const pendingNewSessionTitleTabs = useRef(new Set<string>());
  const providerIdRef = useRef<AiProviderId | "">("");
  const usageDetailsRef = useRef<HTMLDivElement | null>(null);

  function setNotice(
    message: string,
    action?: { label: string; onClick: () => void },
    tone: NoticeState["tone"] = "success"
  ) {
    setNoticeState(message ? { message, tone, actionLabel: action?.label, onAction: action?.onClick } : null);
  }

  useEffect(() => {
    void logPerformance("renderer.mounted", performance.now());
    void loadProviders();
  }, []);

  useEffect(() => {
    providerIdRef.current = providerId;
  }, [providerId]);

  useEffect(() => {
    applyTargets([]);
    if (!providerId) {
      setLoading(false);
      return;
    }
    void loadInitialTargets(providerId);
    // 仅在平台切换时重新加载目标；loadInitialTargets 每渲染重建，纳入会每帧重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const cacheKey = targetId ? sessionCacheKey(targetId, view) : null;
  const sessions = useMemo(() => (cacheKey ? sessionCache[cacheKey] || [] : []), [cacheKey, sessionCache]);
  const searchQuery = query.trim();

  useEffect(() => {
    if (!targetId || !cacheKey || loadedViews[cacheKey]) return;
    void loadSessions(targetId, view);
    // 仅在目标/视图/缓存键变化时加载；loadSessions 每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, view, cacheKey, loadedViews]);

  const localFiltered = useMemo(() => localFilterSessions(sessions, searchQuery), [searchQuery, sessions]);
  const searchMatchesCurrentView =
    Boolean(cacheKey && searchState?.key === cacheKey && searchState.query === searchQuery);
  const filtered = searchQuery && searchMatchesCurrentView ? searchState?.sessions || [] : localFiltered;
  const selectedBatchSessions = useMemo(
    () => sessions.filter((session) => selectedBatchIds.includes(session.id)),
    [sessions, selectedBatchIds]
  );
  const searchLoading = Boolean(searchQuery && searchMatchesCurrentView && searchState?.loading);

  // 传给已 memo 的 SessionList 的稳定回调：身份恒定，避免父级重渲染时让 memo 失效；
  // 内部仍调用最新的处理函数实现（这些 function 声明已提升，可在此引用）。
  const handleSessionContextMenu = useStableCallback(openSessionContextMenu);
  const handleToggleBatchSelection = useStableCallback(toggleBatchSelection);
  const handleOpenSessionTab = useStableCallback(openSessionTab);

  const selected = sessions.find((session) => session.id === selectedId) || null;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const capabilities = selectedProvider?.capabilities;
  const selectedTarget = targets.find((target) => target.id === targetId);
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
  } = useVendors({ selectedTarget, targetId, providerId });
  const activeTab = openTabs.find((tab) => tab.key === activeTabKey) || openTabs[0] || null;
  const activeSession = activeTab?.session || null;
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
  const activeCwd = activeTab?.cwd || activeSession?.cwd;
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
  const workspaceOverlayMessage =
    workspaceBusyMessage ||
    (sessionLoading ? "正在加载会话..." : "");

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
    if (!detailDialogSession) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailDialogSession(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailDialogSession]);

  useEffect(() => {
    if (!openAppMenu) return;

    const close = () => setOpenAppMenu("");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openAppMenu]);

  useEffect(() => {
    setUsageDetailsOpen(false);
  }, [statusSession?.id, supportsUsage]);

  useEffect(() => {
    setWslPathDraft(selectedTarget?.kind === "wsl" ? selectedTarget.codexHome || "~/.codex" : "");
  }, [selectedTarget?.id, selectedTarget?.codexHome, selectedTarget?.kind]);

  useEffect(() => {
    if (!targetId) return;
    setOpenTabs([]);
    setActiveTabKey("");
    setSelectedId("");
    setDetailDialogSession(null);
    setSelectedSessionLoading(false);
    setPendingTerminalTabKey("");
    setTerminalIdsByTabKey({});
    setTerminalInputStatesByTabKey({});
  }, [targetId]);

  useEffect(() => {
    if (!targetId || !cacheKey) return;
    if (!searchQuery) {
      setSearchState(null);
      return;
    }

    let cancelled = false;
    const fallback = localFilterSessions(sessions, searchQuery);
    setSearchState((current) => {
      if (current?.key === cacheKey && current.query === searchQuery) return { ...current, loading: true };
      return { key: cacheKey, query: searchQuery, sessions: fallback, loading: true };
    });

    const timer = window.setTimeout(() => {
      void window.codexConsole
        .searchSessions(targetId, view, searchQuery)
        .then((items) => {
          if (!cancelled) setSearchState({ key: cacheKey, query: searchQuery, sessions: items, loading: false });
        })
        .catch((searchError: any) => {
          if (!cancelled) {
            setSearchState({ key: cacheKey, query: searchQuery, sessions: fallback, loading: false });
            setError(searchError?.message || "全文搜索失败。");
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetId, view, cacheKey, searchQuery, sessions]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const reminder = getContextReminder(statusSession);
    if (!reminder) return;

    const key = `${statusSession!.id}:${reminder.level}`;
    if (contextReminderKeys.current.has(key)) return;
    contextReminderKeys.current.add(key);
    setNotice(
      reminder.message,
      reminder.level === "notice"
        ? undefined
        : {
            label: "复制摘要提示",
            onClick: () => void copyCompressionPrompt(statusSession)
          }
    );
    // 上下文提醒按 会话id+等级 触发一次；依赖全对象会在每次 usage 更新时误触
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSession?.id, statusSession?.usage?.contextPercent]);

  useEffect(() => {
    return window.codexConsole.onOpenSessionSettings(() => {
      openSessionSettingsDialog();
    });
    // 仅在目标变化时重订阅 IPC；handler 每渲染重建，纳入会每帧重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTarget?.id, selectedTarget?.codexHome, selectedTarget?.kind]);


  useEffect(() => {
    if (!detailDialogSession && !activeSession) {
      setSelectedSessionDetails(null);
      setSelectedSessionLoading(false);
      return;
    }

    const sessionToLoad = detailDialogSession || activeSession;
    if (!sessionToLoad) {
      setSelectedSessionDetails(null);
      setSelectedSessionLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(true);

    void window.codexConsole
      .getSession(targetId, sessionToLoad.id)
      .then((session) => {
        if (cancelled) return;
        setSelectedSessionDetails(session);
        applySessionSnapshot(targetId, session);
      })
      .catch((loadError: any) => {
        if (!cancelled) setNotice(loadError?.message || "加载完整会话失败。", undefined, "error");
      })
      .finally(() => {
        if (!cancelled) setSelectedSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // 按 会话id 触发完整加载；依赖整个 session 对象会在任意字段变化时重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, activeSession?.id, detailDialogSession?.id]);

  useEffect(() => {
    const session = selectedSessionDetails || selected;
    if (!targetId || !session || view !== "active" || !supportsBranch) {
      setBranchPanel(null);
      return;
    }

    let cancelled = false;
    setBranchPanel((current) => ({
      sessionId: session.id,
      parent: current?.sessionId === session.id ? current.parent : null,
      children: current?.sessionId === session.id ? current.children : [],
      loading: true
    }));

    const parentSessionId = session.metadata?.branch?.parentSessionId;
    const parentTargetId = session.metadata?.branch?.parentTargetId || targetId;

    void Promise.all([
      parentSessionId
        ? window.codexConsole.getSession(parentTargetId, parentSessionId).catch(() => null)
        : Promise.resolve(null),
      window.codexConsole.listSessionChildren(targetId, session.id).catch(() => [])
    ]).then(([parent, children]) => {
      if (!cancelled) setBranchPanel({ sessionId: session.id, parent, children, loading: false });
    });

    return () => {
      cancelled = true;
    };
    // 按 会话id / 分支父id 触发分支查询；依赖整个 session 对象会过度重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, view, supportsBranch, selected?.id, selectedSessionDetails?.id, selectedSessionDetails?.metadata?.branch?.parentSessionId]);

  useEffect(() => {
    if (!contextMenu && !tabContextMenu) return;

    const close = () => {
      setContextMenu(null);
      setTabContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu, tabContextMenu]);

  async function loadProviders() {
    setLoading(true);
    setError("");
    try {
      const items = await window.codexConsole.listProviders();
      setProviders(items);
    } catch (loadError: any) {
      setError(loadError?.message || "加载 AI 平台失败。");
    } finally {
      setLoading(false);
    }
  }

  async function loadInitialTargets(nextProviderId: AiProviderId) {
    setLoading(true);
    setError("");
    let hasCachedTargets = false;
    const cachedStartedAt = performance.now();

    try {
      const cachedTargets = await window.codexConsole.listCachedTargets(nextProviderId);
      void logPerformance(`targets.cached.loaded.${nextProviderId}`, performance.now() - cachedStartedAt);
      if (cachedTargets.length > 0) {
        if (providerIdRef.current !== nextProviderId) return;
        hasCachedTargets = true;
        applyTargets(cachedTargets);
        setLoading(false);
      }
    } catch {
      void logPerformance(`targets.cached.loaded.${nextProviderId}`, performance.now() - cachedStartedAt, "error");
      // 缓存目标只用于加速首屏，失败时继续走真实探测。
    }

    if (hasCachedTargets) {
      window.setTimeout(() => {
        void loadTargets(nextProviderId, { showLoading: false });
      }, 1500);
      return;
    }

    await loadTargets(nextProviderId, { showLoading: true });
  }

  async function loadTargets(nextProviderId: AiProviderId, options: { showLoading?: boolean } = {}) {
    if (options.showLoading !== false) setLoading(true);
    setError("");
    const startedAt = performance.now();
    try {
      const items = await window.codexConsole.listTargets(nextProviderId);
      if (providerIdRef.current !== nextProviderId) return;
      applyTargets(items);
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt);
    } catch (loadError: any) {
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt, "error");
      if (providerIdRef.current === nextProviderId) setError(loadError?.message || "加载 AI 平台目标失败。");
    } finally {
      if (options.showLoading !== false && providerIdRef.current === nextProviderId) setLoading(false);
    }
  }

  function applyTargets(items: AiTarget[]) {
    setTargets(items);
    setTargetId((current) => items.find((target) => target.id === current)?.id || items[0]?.id || "");
  }

  async function loadSessions(nextTargetId = targetId, nextView = view, force = false) {
    if (!nextTargetId) return;
    const nextCacheKey = sessionCacheKey(nextTargetId, nextView);
    if (!force && loadedViews[nextCacheKey]) return;

    setSessionLoading(true);
    setError("");
    let hasCachedSessions = false;
    if (!force) {
      const cachedStartedAt = performance.now();
      try {
        const cachedItems = await window.codexConsole.listCachedSessions(nextTargetId, nextView);
        void logPerformance(
          `renderer.sessions.${nextView}.cached.${nextTargetId}`,
          performance.now() - cachedStartedAt
        );
        if (cachedItems.length > 0) {
          hasCachedSessions = true;
          const mergedItems = nextView === "active" ? preserveOpenActiveSessions(cachedItems, nextTargetId) : cachedItems;
          setSessionCache((current) => ({ ...current, [nextCacheKey]: mergedItems }));
          setLoadedViews((current) => ({ ...current, [nextCacheKey]: true }));
          setSelectedId((current) => (mergedItems.some((item) => item.id === current) ? current : ""));
          setSessionLoading(false);
          return;
        }
      } catch {
        void logPerformance(
          `renderer.sessions.${nextView}.cached.${nextTargetId}`,
          performance.now() - cachedStartedAt,
          "error"
        );
      }
    }

    const startedAt = performance.now();
    try {
      const items =
        nextView === "trash"
          ? await window.codexConsole.listTrashSessions(nextTargetId)
          : await window.codexConsole.listSessions(nextTargetId);
      const mergedItems = nextView === "active" ? preserveOpenActiveSessions(items, nextTargetId) : items;
      setSessionCache((current) => ({ ...current, [nextCacheKey]: mergedItems }));
      setLoadedViews((current) => ({ ...current, [nextCacheKey]: true }));
      setSelectedId((current) => (mergedItems.some((item) => item.id === current) ? current : ""));
      void logPerformance(`renderer.sessions.${nextView}.loaded.${nextTargetId}`, performance.now() - startedAt);
    } catch (loadError: any) {
      if (!hasCachedSessions) {
        setSessionCache((current) => ({ ...current, [nextCacheKey]: [] }));
        setLoadedViews((current) => ({ ...current, [nextCacheKey]: true }));
        setSelectedId("");
        setError(loadError?.message || "加载 AI 会话失败。");
      }
      void logPerformance(`renderer.sessions.${nextView}.loaded.${nextTargetId}`, performance.now() - startedAt, "error");
    } finally {
      if (!hasCachedSessions) setSessionLoading(false);
    }
  }

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
        tab.targetId === nextTargetId && tab.session?.id === session.id ? { ...tab, session } : tab
      )
    );
    setSelectedSessionDetails((current) => (current?.id === session.id ? session : current));
    setDetailDialogSession((current) => (current?.id === session.id ? session : current));
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
        ? { ...tab, session: withCustomTitle(tab.session, metadata) }
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

  async function refreshSessionSnapshot(nextTargetId: string, sessionId: string) {
    try {
      const session = await window.codexConsole.getSession(nextTargetId, sessionId);
      applySessionSnapshot(nextTargetId, session);
      return session;
    } catch {
      return null;
    }
  }

  async function refreshCurrentView() {
    if (!targetId) {
      if (providerId) await loadTargets(providerId, { showLoading: true });
      return;
    }

    await loadSessions(targetId, view, true);
    const session = selectedSessionDetails || activeSession || selected;
    if (session) await refreshSessionSnapshot(targetId, session.id);
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
    setPendingTerminalTabKey("");
  }

  function toggleBatchSelection(sessionId: string) {
    setSelectedBatchIds((current) =>
      current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId]
    );
  }

  function toggleAllVisibleSessions() {
    const visibleIds = filtered.map((session) => session.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedBatchIds.includes(id));
    setSelectedBatchIds((current) => {
      if (allSelected) return current.filter((id) => !visibleIds.includes(id));
      return Array.from(new Set([...current, ...visibleIds]));
    });
  }

  async function deleteSessionById(session: AiSession) {
    const confirmed = window.confirm(`删除此会话？\n\n${session.title}`);
    if (!confirmed) return;

    await runWorkspaceAction("正在删除会话...", async () => {
      await closeOpenSessionTerminal(session);
      await window.codexConsole.deleteSession(targetId, session.id, { filePath: session.filePath });
      updateCachedSessions(targetId, "active", (current) => current.filter((item) => item.id !== session.id));
      invalidateLoadedView(targetId, "trash");
      if (view === "trash") await loadSessions(targetId, "trash", true);
      setSelectedId((currentSelectedId) => (currentSelectedId === session.id ? "" : currentSelectedId));
      setSelectedSessionDetails(null);
      setNotice("会话已移动到回收目录。");
    });
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
        setPendingResumeSession({ session, missingCwd: sessionCwd });
        setNewSessionCwd(DEFAULT_NEW_SESSION_CWD);
        setNewSessionTitle("");
        setNewSessionPrompt("");
        setNewSessionCliArgs("");
        setNewSessionDialogOpen(true);
        return;
      }
    }

    const key = tabKey(targetId, session.id);
    setSelectedId(session.id);
    setPendingTerminalTabKey("");
    setOpenTabs((current) =>
      current.some((tab) => tab.key === key)
        ? current
        : [...current, { key, targetId, session, title: shortSessionId(session.id) }]
    );
    setActiveTabKey(key);
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

  function openRenameSession(session: AiSession) {
    setRenameSession(session);
    setRenameDraft(session.metadata?.customTitle || session.title);
    setRenameError("");
  }

  function closeRenameSession() {
    if (renameBusy) return;
    setRenameSession(null);
    setRenameError("");
  }

  async function saveCustomSessionTitle(value = renameDraft) {
    if (!renameSession) return;
    const title = value.trim();
    if (!title && value !== "") {
      setRenameError("请输入会话名称。");
      return;
    }

    setRenameBusy(true);
    setRenameError("");
    try {
      const metadata = await window.codexConsole.setSessionCustomTitle(targetId, renameSession.id, title);
      applyCustomTitle(targetId, renameSession.id, metadata);
      setNotice(title ? "会话名称已保存。" : "已恢复自动标题。");
      setRenameSession(null);
    } catch (saveError: any) {
      setRenameError(saveError?.message || "保存会话名称失败。");
    } finally {
      setRenameBusy(false);
    }
  }

  async function chooseNewSessionDirectory() {
    const result = await window.codexConsole.chooseDirectory();
    if (!result.filePath) return;
    setNewSessionCwd(normalizeChosenDirectory(result.filePath, selectedTarget));
  }

  function resetNewSessionDialog() {
    setPendingResumeSession(null);
    setNewSessionCwd(DEFAULT_NEW_SESSION_CWD);
    setNewSessionTitle("");
    setNewSessionPrompt("");
    setNewSessionCliArgs("");
    setNewSessionDialogOpen(true);
  }

  function closeNewSessionDialog() {
    setNewSessionDialogOpen(false);
    setPendingResumeSession(null);
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
    const usesDefaultCwd = cwd === DEFAULT_NEW_SESSION_CWD;
    const displayTitle = customTitle.trim() || (index === 1 ? "新会话" : `新会话 ${index}`);
    setNewSessionIndex(index + 1);
    setSelectedId("");
    setPendingTerminalTabKey(key);
    setOpenTabs((current) => [
      ...current,
      {
        key,
        targetId: nextTargetId,
        title: displayTitle,
        cwd: usesDefaultCwd ? undefined : cwd,
        useCodexCwdFlag: !usesDefaultCwd,
        prompt: prompt.trim() || undefined,
        cliArgs: cliArgs.trim() || undefined,
        customTitle: customTitle.trim() || undefined,
        knownSessionIds: sessions.map((session) => session.id),
        createdAt: Date.now()
      }
    ]);
    setActiveTabKey(key);
    setError("");
    setNotice("");
    setNewSessionDialogOpen(false);
  }

  function openResumeSessionWithDirectory(cwd: string) {
    if (!pendingResumeSession) return;
    const session = pendingResumeSession.session;
    const key = tabKey(targetId, session.id);
    setSelectedId(session.id);
    setPendingTerminalTabKey("");
    setOpenTabs((current) =>
      current.some((tab) => tab.key === key)
        ? current.map((tab) => (tab.key === key ? { ...tab, cwd, useCodexCwdFlag: true } : tab))
        : [...current, { key, targetId, session, title: shortSessionId(session.id), cwd, useCodexCwdFlag: true }]
    );
    setActiveTabKey(key);
    setError("");
    setNotice("");
    setPendingResumeSession(null);
    setNewSessionDialogOpen(false);
  }

  function openDerivedSession(session: AiSession) {
    const key = tabKey(targetId, session.id);
    setView("active");
    setSelectedId(session.id);
    setDetailDialogSession(null);
    setPendingTerminalTabKey(key);
    setOpenTabs((current) =>
      current.some((tab) => tab.key === key)
        ? current
        : [...current, { key, targetId, session, title: shortSessionId(session.id) }]
    );
    setActiveTabKey(key);
    setError("");
    setNotice("已创建新的分支会话。");
  }

  async function branchFromTurn(session: AiSession, turn: ConversationTurn) {
    setError("");
    setNotice("");
    setPendingTerminalTabKey("");
    try {
      await runWorkspaceAction("正在创建分支会话...", async () => {
        const messageIndex = getBranchMessageCount(turn);
        if (messageIndex <= 0) throw new Error("当前会话没有可保留的上下文。");
        const branch = await window.codexConsole.branchSession({
          targetId,
          sessionId: session.id,
          messageIndex
        });
        await loadSessions(targetId, "active", true);
        setBranchPanel((current) =>
          current?.sessionId === session.id
            ? { ...current, children: mergeSession(current.children, branch), loading: false }
            : current
        );
        openDerivedSession(branch);
      });
    } finally {
      setPendingTerminalTabKey("");
    }
  }

  function closeSessionTab(key: string) {
    closeSessionTabs([key]);
  }

  function closeSessionTabs(keys: string[]) {
    const keysToClose = new Set(keys);
    if (keysToClose.size === 0) return;
    setOpenTabs((current) => {
      const firstClosedIndex = current.findIndex((tab) => keysToClose.has(tab.key));
      if (firstClosedIndex === -1) return current;
      const next = current.filter((tab) => !keysToClose.has(tab.key));
      if (pendingTerminalTabKey && keysToClose.has(pendingTerminalTabKey)) {
        setPendingTerminalTabKey("");
      }
      if (activeTabKey && keysToClose.has(activeTabKey)) {
        const fallback = next[Math.max(0, firstClosedIndex - 1)] || next[0] || null;
        setActiveTabKey(fallback ? fallback.key : "");
        setSelectedId(fallback?.session?.id || "");
      }
      setTerminalIdsByTabKey((currentIds) => {
        const nextIds = { ...currentIds };
        let changed = false;
        keysToClose.forEach((key) => {
          if (key in nextIds) {
            delete nextIds[key];
            changed = true;
          }
        });
        return changed ? nextIds : currentIds;
      });
      setTerminalInputStatesByTabKey((currentStates) => {
        const nextStates = { ...currentStates };
        let changed = false;
        keysToClose.forEach((key) => {
          if (key in nextStates) {
            delete nextStates[key];
            changed = true;
          }
        });
        return changed ? nextStates : currentStates;
      });
      return next;
    });
  }

  function closeOtherSessionTabs(key: string) {
    closeSessionTabs(openTabs.filter((tab) => tab.key !== key).map((tab) => tab.key));
  }

  function closeAllSessionTabs() {
    closeSessionTabs(openTabs.map((tab) => tab.key));
  }

  function handleTerminalInputState(tabKey: string, state: TerminalInputState) {
    setTerminalInputStatesByTabKey((current) => {
      const previous = current[tabKey];
      if (previous?.mode === state.mode && previous.composerVisible === state.composerVisible) return current;
      return { ...current, [tabKey]: state };
    });
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
    setTerminalInputStatesByTabKey((current) => ({
      ...current,
      [activeTab.key]: {
        composerVisible: true,
        mode: nextMode
      }
    }));
  }

  function handleTerminalReady(tabKey: string, terminalId?: string) {
    if (terminalId) {
      setTerminalIdsByTabKey((current) => ({ ...current, [tabKey]: terminalId }));
    }
    const tab = openTabs.find((item) => item.key === tabKey);
    if (tab?.customTitle) void finalizeNewSession(tab);
    if (pendingTerminalTabKey !== tabKey) return;
    setPendingTerminalTabKey("");
  }

  function handleTerminalExit(tabKey: string, exitCode: number) {
    if (exitCode !== 0) return;
    const tab = openTabs.find((item) => item.key === tabKey);
    if (tab?.session) {
      void refreshSessionSnapshot(tab.targetId, tab.session.id);
    } else if (tab?.targetId) {
      void finalizeNewSession(tab);
    }
    closeSessionTab(tabKey);
  }

  async function finalizeNewSession(tab: TerminalTab) {
    if (pendingNewSessionTitleTabs.current.has(tab.key)) return;
    pendingNewSessionTitleTabs.current.add(tab.key);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const items = await window.codexConsole.listSessions(tab.targetId);
        const rendered = preserveOpenActiveSessions(items, tab.targetId);
        const activeCacheKey = sessionCacheKey(tab.targetId, "active");
        setSessionCache((current) => ({ ...current, [activeCacheKey]: rendered }));
        setLoadedViews((current) => ({ ...current, [activeCacheKey]: true }));

        if (!tab.customTitle) return;
        const candidates = rendered.filter((session) => {
          if (tab.knownSessionIds?.includes(session.id)) return false;
          if (tab.cwd && session.cwd && tab.cwd !== session.cwd) return false;
          const updatedAt = Date.parse(session.updatedAt || session.createdAt || "");
          return !tab.createdAt || (Number.isFinite(updatedAt) && updatedAt >= tab.createdAt - 10_000);
        });
        if (candidates.length === 1) {
          const session = candidates[0];
          const metadata = await window.codexConsole.setSessionCustomTitle(tab.targetId, session.id, tab.customTitle);
          applyCustomTitle(tab.targetId, session.id, metadata);
          return;
        }
        if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      }
    } catch {
      // 新会话标题关联失败不影响 CLI 会话；用户仍可从列表右键重命名。
    } finally {
      pendingNewSessionTitleTabs.current.delete(tab.key);
    }
  }

  async function closeOpenSessionTerminal(session: AiSession) {
    const key = tabKey(targetId, session.id);
    const terminalId = terminalIdsByTabKey[key];
    if (terminalId) await window.codexConsole.stopTerminal(terminalId);
    closeSessionTab(key);
  }

  async function restoreSessionById(session: AiSession) {
    await runWorkspaceAction("正在恢复会话...", async () => {
      await window.codexConsole.restoreSession(targetId, session.id);
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => item.id !== session.id));
      if (loadedViews[sessionCacheKey(targetId, "active")]) {
        updateCachedSessions(targetId, "active", (current) => mergeSession(current, session));
      }
      invalidateLoadedView(targetId, "trash");
      setSelectedId((currentSelectedId) => (currentSelectedId === session.id ? "" : currentSelectedId));
      setNotice("会话已恢复。");
    });
  }

  async function purgeSessionById(session: AiSession) {
    const confirmed = window.confirm(`是否确认删除？\n\n${session.title}`);
    if (!confirmed) return;

    await runWorkspaceAction("正在彻底删除会话...", async () => {
      await closeOpenSessionTerminal(session);
      await window.codexConsole.purgeSession(targetId, session.id, { filePath: session.filePath });
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => item.id !== session.id));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((currentSelectedId) => (currentSelectedId === session.id ? "" : currentSelectedId));
      setNotice("会话已彻底删除。");
    });
  }

  async function deleteSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0) return;
    const confirmed = window.confirm(`删除选中的 ${items.length} 个会话？`);
    if (!confirmed) return;

    await runWorkspaceAction("正在批量删除会话...", async () => {
      await Promise.all(items.map((session) => closeOpenSessionTerminal(session)));
      await window.codexConsole.deleteSessions(
        targetId,
        items.map((session) => ({ id: session.id, filePath: session.filePath }))
      );
      updateCachedSessions(targetId, "active", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已移动 ${items.length} 个会话到回收目录。`);
    });
  }

  async function restoreSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0) return;

    await runWorkspaceAction("正在批量恢复会话...", async () => {
      for (const session of items) {
        await window.codexConsole.restoreSession(targetId, session.id);
      }
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      if (loadedViews[sessionCacheKey(targetId, "active")]) {
        updateCachedSessions(targetId, "active", (current) => {
          return items.reduce((next, session) => mergeSession(next, session), current);
        });
      }
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已恢复 ${items.length} 个会话。`);
    });
  }

  async function purgeSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0) return;
    const confirmed = window.confirm(`彻底删除选中的 ${items.length} 个会话？`);
    if (!confirmed) return;

    await runWorkspaceAction("正在批量彻底删除会话...", async () => {
      await Promise.all(items.map((session) => closeOpenSessionTerminal(session)));
      await window.codexConsole.purgeSessions(
        targetId,
        items.map((session) => ({ id: session.id, filePath: session.filePath }))
      );
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已彻底删除 ${items.length} 个会话。`);
    });
  }

  async function configureWslCodexHome() {
    const target = selectedTarget;
    if (!target?.distro) return;

    const value = wslPathDraft.trim();
    if (!value) return;

    setError("");
    setNotice("");
    try {
      await window.codexConsole.setWslCodexHome(target.distro, value);
      setNotice("WSL Codex 目录已保存。");
      setSessionSettingsOpen(false);
      await loadTargets("codex", { showLoading: true });
      setLoadedViews((current) => ({ ...current, [sessionCacheKey(`wsl:${target.distro}`, view)]: false }));
      await loadSessions(`wsl:${target.distro}`, view, true);
    } catch (configureError: any) {
      setNotice(configureError?.message || "保存 WSL Codex 目录失败。");
    }
  }

  async function clearWslCodexHome() {
    const target = selectedTarget;
    if (!target?.distro) return;

    setError("");
    setNotice("");
    try {
      await window.codexConsole.clearWslCodexHome(target.distro);
      setNotice("已恢复自动探测会话目录。");
      setSessionSettingsOpen(false);
      await loadTargets("codex", { showLoading: true });
      setLoadedViews((current) => ({ ...current, [sessionCacheKey(`wsl:${target.distro}`, view)]: false }));
      await loadSessions(`wsl:${target.distro}`, view, true);
    } catch (clearError: any) {
      setNotice(clearError?.message || "恢复自动探测失败。");
    }
  }

  function openSessionSettingsDialog() {
    setWslPathDraft(selectedTarget?.kind === "wsl" ? selectedTarget.codexHome || "~/.codex" : "");
    setSessionSettingsOpen(true);
    setNotice("");
  }

  async function runAppCommand(command: AppCommand) {
    try {
      await window.codexConsole.appCommand(command);
    } catch (commandError: any) {
      setError(commandError?.message || "菜单操作失败。");
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

  async function runWorkspaceAction(message: string, action: () => Promise<unknown>) {
    setError("");
    setWorkspaceBusyMessage(message);
    try {
      await action();
    } catch (actionError: any) {
      setError(actionError?.message || "操作失败。");
    } finally {
      setWorkspaceBusyMessage("");
      setWorkspaceFocusRequest((current) => current + 1);
      window.setTimeout(() => focusActiveWorkspaceInput(workspaceRef.current), 0);
    }
  }

  const appMenus: AppMenuDefinition[] = [
    {
      id: "file",
      label: "文件",
      items: [
        { label: "管理 skill", disabled: !supportsSkills || !targetId, action: () => void openSkillManager() },
        { label: "设置会话", disabled: !supportsSessionSettings || selectedTarget?.kind !== "wsl", action: openSessionSettingsDialog },
        { separator: true, label: "" },
        {
          label: "导出",
          disabled: !supportsExport || !activeSession,
          children: [
            { label: "导出 Markdown", disabled: !supportsExport || !activeSession, action: () => void exportActiveSession("markdown") },
            { label: "导出 JSON", disabled: !supportsExport || !activeSession, action: () => void exportActiveSession("json") },
            { label: "导出 HTML", disabled: !supportsExport || !activeSession, action: () => void exportActiveSession("html") }
          ]
        },
        { separator: true, label: "" },
        { label: "退出", action: () => void runAppCommand("quit") }
      ]
    },
    {
      id: "toolbox",
      label: "工具箱",
      items: [
        { label: "供应商管理", disabled: !targetId, action: () => void openVendorManager() },
        { label: "压缩提示", action: () => void openCompressionManager() }
      ]
    },
    {
      id: "terminal",
      label: "终端",
      items: [
        {
          label: "新建终端",
          action: () => {
            setSystemTerminalOpen(true);
            setSystemTerminalMinimized(false);
            setSystemTerminalCreateSignal((current) => current + 1);
          }
        }
      ]
    },
    {
      id: "help",
      label: "帮助",
      items: [
        { label: "安装 CLI", action: openCliInstallerDialog },
        { separator: true, label: "" },
        { label: "打开日志目录", action: () => void runAppCommand("openLogDir") },
        { label: "关于 AI 可视化控制台", action: () => void runAppCommand("about") }
      ]
    }
  ];

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
          allSelected={filtered.length > 0 && filtered.every((session) => selectedBatchIds.includes(session.id))}
          onToggleAll={toggleAllVisibleSessions}
          onRestoreBatch={() => void restoreSelectedBatch()}
          onPurgeBatch={() => void purgeSelectedBatch()}
          onDeleteBatch={() => void deleteSelectedBatch()}
        />

        <SessionList
          sessions={filtered}
          loading={sessionLoading || searchLoading}
          emptyMessage={searchQuery ? "未找到匹配会话。" : view === "trash" ? "回收站为空。" : "未找到会话。"}
          activeSessionId={activeSession?.id}
          selectedId={selected?.id}
          selectedBatchIds={selectedBatchIds}
          onContextMenu={handleSessionContextMenu}
          onToggleBatch={handleToggleBatchSelection}
          onOpen={handleOpenSessionTab}
        />
      </aside>
      <section className="workspace">
        {error && <div className="error-banner">{error}</div>}

        <section className="terminal-workspace" ref={workspaceRef}>
            <section className="detail">
              <div className="detail-main">
                <div className="detail-title-row">
                  <button
                    className="workspace-sidebar-toggle"
                    title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                    onClick={() => setSidebarCollapsed((current) => !current)}
                  >
                    {sidebarCollapsed ? "›" : "‹"}
                  </button>
                  <h2 title={activeTitle}>{activeTitle}</h2>
                </div>
              </div>

              <div className="actions">
                {activeSession && (
                  <button className="secondary" onClick={() => openSessionDetail(activeSession)}>
                    详情
                  </button>
                )}
                {providerId && targetId && <button onClick={() => resetNewSessionDialog()}>新会话</button>}
              </div>
            </section>

            <TerminalTabs
              tabs={openTabs}
              activeTabKey={activeTabKey}
              tabsRef={terminalTabsRef}
              onWheel={handleTerminalTabsWheel}
              onSelect={(tabKey, sessionId) => {
                setActiveTabKey(tabKey);
                setSelectedId(sessionId);
              }}
              onContextMenu={openTerminalTabContextMenu}
              onClose={closeSessionTab}
            />
            <div className="terminal-stack">
              {openTabs.length === 0 ? (
                <div className="empty-terminal">当前无对话</div>
              ) : (
                <Suspense fallback={<div className="empty-terminal">正在加载终端...</div>}>
                  {openTabs.map((tab) => (
                    <EmbeddedTerminal
                      key={tab.key}
                      targetId={tab.targetId}
                      sessionId={tab.session?.id}
                      cwd={tab.cwd || tab.session?.cwd}
                      codexHome={targets.find((target) => target.id === tab.targetId)?.codexHome}
                      useCodexCwdFlag={tab.useCodexCwdFlag}
                      prompt={tab.prompt}
                      cliArgs={tab.cliArgs}
                      title={tab.session?.title || tab.title}
                      active={tab.key === activeTabKey}
                      focusRequest={workspaceFocusRequest}
                      requestedInputMode={terminalInputStatesByTabKey[tab.key]?.mode}
                      onReady={(terminalId) => handleTerminalReady(tab.key, terminalId)}
                      onExit={(exitCode) => handleTerminalExit(tab.key, exitCode)}
                      onInputModeChange={(state) => handleTerminalInputState(tab.key, state)}
                    />
                  ))}
                </Suspense>
              )}
            </div>
            {systemTerminalOpen && (
              <Suspense fallback={null}>
                <SystemTerminal
                  targetId={targetId}
                  cwd={activeCwd && activeCwd !== "~/.akim" ? activeCwd : undefined}
                  minimized={systemTerminalMinimized}
                  createSignal={systemTerminalCreateSignal}
                  onClose={() => setSystemTerminalOpen(false)}
                  onToggleMinimized={() => setSystemTerminalMinimized((current) => !current)}
                />
              </Suspense>
            )}
        </section>

        {detailDialogSession && (
          <SessionDetailModal
            session={detailDialogSession}
            selectedSessionDetails={selectedSessionDetails}
            loading={selectedSessionLoading}
            branchPanel={branchPanel}
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
            onRename={() => openRenameSession(contextMenu.session)}
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

        {renameSession && (
          <SessionRenameDialog
            session={renameSession}
            value={renameDraft}
            error={renameError}
            busy={renameBusy}
            onChange={(value) => {
              setRenameDraft(value);
              if (renameError) setRenameError("");
            }}
            onClose={closeRenameSession}
            onRestore={() => void saveCustomSessionTitle("")}
            onSave={() => void saveCustomSessionTitle()}
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

        {workspaceOverlayMessage && (
          <div className="workspace-overlay" aria-live="polite" aria-busy="true">
            <span>{workspaceOverlayMessage}</span>
          </div>
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
          onConfirm={() =>
            pendingResumeSession
              ? openResumeSessionWithDirectory(newSessionCwd)
              : openNewSessionTab(targetId, newSessionCwd, newSessionTitle, newSessionPrompt, newSessionCliArgs)
          }
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
	    </main>
    </div>
	  );
	}

function sessionCacheKey(targetId: string, view: SessionView): SessionCacheKey {
  return `${targetId}:${view}` as SessionCacheKey;
}

function getContextLevel(percent?: number) {
  if (typeof percent !== "number") return "unknown";
  if (percent >= 90) return "danger";
  if (percent >= 80) return "warning";
  if (percent >= 60) return "notice";
  return "ok";
}

function getContextReminder(session?: AiSession | null) {
  const percent = session?.usage?.contextPercent;
  if (!session || typeof percent !== "number" || percent < 60) return null;

  const left = session.usage?.contextLeftPercent;
  const used = formatCompactNumber(session.usage?.contextUsedTokens);
  const windowSize = formatCompactNumber(session.usage?.contextWindow);
  const suffix = typeof left === "number" ? `，剩余 ${left}%（${used} / ${windowSize}）` : "";

  if (percent >= 90) {
    return {
      level: "danger",
      message: `上下文已使用 ${percent}%${suffix}，建议立即压缩摘要或创建新分支。`
    };
  }

  if (percent >= 80) {
    return {
      level: "warning",
      message: `上下文已使用 ${percent}%${suffix}，建议准备压缩或拆分会话。`
    };
  }

  return {
    level: "notice",
    message: `上下文已使用 ${percent}%${suffix}，后续长任务建议留意上下文。`
  };
}

function logPerformance(label: string, durationMs: number, status?: string) {
  return window.codexConsole.logPerformance(label, durationMs, status);
}

const DEFAULT_NEW_SESSION_CWD = "~/.akim";

function normalizeChosenDirectory(filePath: string, target?: AiTarget) {
  if (target?.kind === "wsl") return windowsPathToWslPath(filePath);
  return filePath;
}

function windowsPathToWslPath(filePath: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replace(/\\/g, "/");
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function focusActiveWorkspaceInput(workspace: HTMLElement | null) {
  const activePanel = workspace?.querySelector<HTMLElement>(".terminal-panel.active");
  const target =
    activePanel?.querySelector<HTMLTextAreaElement>(".terminal-composer.active textarea") ||
    activePanel?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ||
    activePanel?.querySelector<HTMLElement>(".terminal-host .xterm");
  target?.focus();
}

function getBranchMessageCount(turn: ConversationTurn) {
  for (let index = turn.replies.length - 1; index >= 0; index -= 1) {
    const entry = turn.replies[index];
    if (entry.message.role === "assistant") return entry.index + 1;
  }
  if (turn.replies.length > 0) return turn.replies[turn.replies.length - 1].index + 1;
  return turn.user ? turn.user.index + 1 : 0;
}
