import { useState, type Dispatch, type SetStateAction } from "react";
import {
  omitTerminalTabRecords,
  removeTerminalTabs,
  type TerminalTab,
  upsertTerminalTab
} from "./terminal-tab-state";

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

  function resetTerminalTabs() {
    setOpenTabs([]);
    setActiveTabKey("");
    setPendingTerminalTabKey("");
    setTerminalIdsByTabKey({});
    setTerminalInputStatesByTabKey({});
  }

  function activateTerminalTab(tab: TerminalTab, pending = false) {
    setOpenTabs((current) => upsertTerminalTab(current, tab));
    setActiveTabKey(tab.key);
    setSelectedId(tab.session?.id || "");
    setPendingTerminalTabKey(pending ? tab.key : "");
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

  function clearPendingTerminalTab() {
    setPendingTerminalTabKey("");
  }

  return {
    openTabs,
    setOpenTabs,
    activeTabKey,
    setActiveTabKey,
    terminalIdsByTabKey,
    terminalInputStatesByTabKey,
    resetTerminalTabs,
    activateTerminalTab,
    closeTerminalTabs,
    setTerminalInputState,
    registerTerminalReady,
    markTerminalExited,
    clearPendingTerminalTab
  };
}
