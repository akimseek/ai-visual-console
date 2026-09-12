import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  omitTerminalTabRecords,
  removeTerminalTabs,
  type TerminalTab,
  upsertTerminalTab
} from "./terminal-tab-state";
import { applyTerminalStatus, type TerminalTabAttention } from "./terminal-tab-state";

type TerminalInputState = {
  mode: "composer" | "terminal";
  composerVisible: boolean;
};

export function useTerminalTabs({ setSelectedId }: { setSelectedId: Dispatch<SetStateAction<string>> }) {
  const [openTabs, setOpenTabs] = useState<TerminalTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [pendingTerminalTabKey, setPendingTerminalTabKey] = useState("");
  const [terminalIdsByTabKey, setTerminalIdsByTabKey] = useState<Record<string, string>>({});
  const [terminalInputStatesByTabKey, setTerminalInputStatesByTabKey] = useState<Record<string, TerminalInputState>>({});
  const [terminalAttentionByTabKey, setTerminalAttentionByTabKey] = useState<Record<string, TerminalTabAttention>>({});
  const terminalAttentionRef = useRef(terminalAttentionByTabKey);
  terminalAttentionRef.current = terminalAttentionByTabKey;
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const notifiedAttentionRef = useRef(new Set<string>());
  const acknowledgedAttentionRef = useRef<Record<string, { turnId?: number; key: string }>>({});
  const terminalIdsRef = useRef(terminalIdsByTabKey);
  terminalIdsRef.current = terminalIdsByTabKey;

  useEffect(() => {
    const removeStatusListener = window.codexConsole.onTerminalStatus((event) => {
      const tabKey = Object.entries(terminalIdsRef.current).find(([, terminalId]) => terminalId === event.terminalId)?.[0];
      if (!tabKey) return;
      if (event.status === "running") {
        const acknowledged = acknowledgedAttentionRef.current[tabKey];
        if (!acknowledged || event.turnId === undefined || acknowledged.turnId !== event.turnId) {
          delete acknowledgedAttentionRef.current[tabKey];
        }
        for (const signature of notifiedAttentionRef.current) {
          if (signature.startsWith(`${tabKey}:`)) notifiedAttentionRef.current.delete(signature);
        }
        setTerminalAttentionByTabKey((current) => {
          if (!(tabKey in current)) return current;
          const next = { ...current };
          delete next[tabKey];
          return next;
        });
        return;
      }
      const attentionKey = `${event.status}\0${event.attention?.title || ""}\0${event.attention?.detail || ""}`;
      const acknowledged = acknowledgedAttentionRef.current[tabKey];
      if (acknowledged?.key === attentionKey && (event.turnId === undefined || acknowledged.turnId === event.turnId)) return;
      setTerminalAttentionByTabKey((current) => ({
        ...current,
        [tabKey]: applyTerminalStatus(current[tabKey], event)
      }));
    });
    return removeStatusListener;
  }, []);

  useEffect(() => {
    const removeNotificationListener = window.codexConsole.onTerminalAttentionNotificationClicked((tabKey) => {
      const tab = openTabsRef.current.find((item) => item.key === tabKey);
      if (!tab) return;
      setActiveTabKey(tabKey);
      setSelectedId(tab.session?.id || "");
      const previous = terminalAttentionRef.current[tabKey];
      if (previous) acknowledgedAttentionRef.current[tabKey] = {
        turnId: previous.turnId,
        key: `${previous.status}\0${previous.title || ""}\0${previous.detail || ""}`
      };
      setTerminalAttentionByTabKey((current) => {
        if (!(tabKey in current)) return current;
        const next = { ...current };
        delete next[tabKey];
        return next;
      });
    });
    return removeNotificationListener;
  }, [setSelectedId]);

  useEffect(() => {
    for (const [tabKey, attention] of Object.entries(terminalAttentionByTabKey)) {
      if (!attention.kind || !attention.unread) continue;
      const tab = openTabsRef.current.find((item) => item.key === tabKey);
      if (!tab) continue;
      const signature = `${tabKey}:${attention.updatedAt}:${attention.kind}:${attention.detail || ""}`;
      if (notifiedAttentionRef.current.has(signature)) continue;
      notifiedAttentionRef.current.add(signature);
      void window.codexConsole.notifyTerminalAttention({
        tabKey,
        title: `${tab.title} · ${attention.title || "终端状态已更新"}`,
        detail: attention.detail
      });
    }
  }, [terminalAttentionByTabKey]);

  function resetTerminalTabs() {
    setOpenTabs([]);
    setActiveTabKey("");
    setPendingTerminalTabKey("");
    setTerminalIdsByTabKey({});
    setTerminalInputStatesByTabKey({});
    setTerminalAttentionByTabKey({});
    acknowledgedAttentionRef.current = {};
    notifiedAttentionRef.current.clear();
  }

  function activateTerminalTab(tab: TerminalTab, pending = false) {
    // 历史会话首次打开时若复用了旧标签键，但尚未绑定新的 PTY，清除旧轮次提醒；
    // 已在运行的同一标签则保留其真实提醒状态。
    if (tab.session && !terminalIdsRef.current[tab.key]) {
      delete acknowledgedAttentionRef.current[tab.key];
      setTerminalAttentionByTabKey((current) => {
        if (!(tab.key in current)) return current;
        const next = { ...current };
        delete next[tab.key];
        return next;
      });
    }
    setOpenTabs((current) => upsertTerminalTab(current, tab));
    setActiveTabKey(tab.key);
    setSelectedId(tab.session?.id || "");
    setPendingTerminalTabKey(pending ? tab.key : "");
  }

  // 选中标签时同步左侧会话选择，避免页面调用方只更新其中一份状态。
  function selectTerminalTab(tabKey: string, sessionId: string) {
    setActiveTabKey(tabKey);
    setSelectedId(sessionId);
  }

  function closeTerminalTabs(keys: string[]) {
    const keysToClose = new Set(keys);
    if (keysToClose.size === 0) return;
    setOpenTabs((current) => {
      const { tabs, fallback } = removeTerminalTabs(current, keysToClose);
      if (tabs === current) return current;
      if (pendingTerminalTabKey && keysToClose.has(pendingTerminalTabKey)) {
        setPendingTerminalTabKey("");
      }
      if (activeTabKey && keysToClose.has(activeTabKey)) {
        setActiveTabKey(fallback ? fallback.key : "");
        setSelectedId(fallback?.session?.id || "");
      }
      setTerminalIdsByTabKey((currentIds) => omitTerminalTabRecords(currentIds, keysToClose));
      setTerminalInputStatesByTabKey((currentStates) => omitTerminalTabRecords(currentStates, keysToClose));
      setTerminalAttentionByTabKey((currentStates) => omitTerminalTabRecords(currentStates, keysToClose));
      keysToClose.forEach((key) => {
        delete acknowledgedAttentionRef.current[key];
        for (const signature of notifiedAttentionRef.current) {
          if (signature.startsWith(`${key}:`)) notifiedAttentionRef.current.delete(signature);
        }
      });
      return tabs;
    });
  }

  function setTerminalInputState(tabKey: string, state: TerminalInputState) {
    setTerminalInputStatesByTabKey((current) => {
      const previous = current[tabKey];
      if (previous?.mode === state.mode && previous.composerVisible === state.composerVisible) return current;
      return { ...current, [tabKey]: state };
    });
  }

  function registerTerminalReady(tabKey: string, terminalId?: string) {
    if (terminalId) setTerminalIdsByTabKey((current) => ({ ...current, [tabKey]: terminalId }));
    if (pendingTerminalTabKey === tabKey) setPendingTerminalTabKey("");
  }

  function markTerminalExited(tabKey: string) {
    setTerminalIdsByTabKey((current) => omitTerminalTabRecords(current, new Set([tabKey])));
  }

  function clearTerminalAttention(tabKey: string) {
    const previous = terminalAttentionRef.current[tabKey];
    if (previous) acknowledgedAttentionRef.current[tabKey] = {
      turnId: previous.turnId,
      key: `${previous.status}\0${previous.title || ""}\0${previous.detail || ""}`
    };
    setTerminalAttentionByTabKey((current) => {
      if (!(tabKey in current)) return current;
      const next = { ...current };
      delete next[tabKey];
      return next;
    });
  }

  function dismissTerminalAttention(tabKey: string) {
    const previous = terminalAttentionRef.current[tabKey];
    if (previous) acknowledgedAttentionRef.current[tabKey] = {
      turnId: previous.turnId,
      key: `${previous.status}\0${previous.title || ""}\0${previous.detail || ""}`
    };
    setTerminalAttentionByTabKey((current) => {
      if (!(tabKey in current)) return current;
      const next = { ...current };
      delete next[tabKey];
      return next;
    });
  }

  function recordTerminalError(tabKey: string, detail: string) {
    delete acknowledgedAttentionRef.current[tabKey];
    setTerminalAttentionByTabKey((current) => ({
      ...current,
      [tabKey]: {
        status: "error",
        kind: "error",
        title: "终端启动失败",
        detail: detail.slice(0, 240),
        unread: true,
        updatedAt: Date.now()
      }
    }));
  }

  function clearPendingTerminalTab() {
    setPendingTerminalTabKey("");
  }

  return {
    openTabs,
    setOpenTabs,
    activeTabKey,
    terminalIdsByTabKey,
    terminalInputStatesByTabKey,
    terminalAttentionByTabKey,
    resetTerminalTabs,
    activateTerminalTab,
    selectTerminalTab,
    closeTerminalTabs,
    setTerminalInputState,
    registerTerminalReady,
    markTerminalExited,
    clearTerminalAttention,
    dismissTerminalAttention,
    recordTerminalError,
    clearPendingTerminalTab
  };
}
