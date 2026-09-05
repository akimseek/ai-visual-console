import { lazy, Suspense, type MouseEvent, type RefObject, type WheelEvent } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { AiSession, ApiVendor } from "../../types";
import type { TerminalTab } from "./terminal-tab-state";
import { TerminalTabs } from "./terminal-tabs";

const EmbeddedTerminal = lazy(() =>
  import("./embedded-terminal").then((module) => ({ default: module.EmbeddedTerminal }))
);
const SystemTerminal = lazy(() =>
  import("./system-terminal").then((module) => ({ default: module.SystemTerminal }))
);

export type TerminalInputState = {
  mode: "composer" | "terminal";
  composerVisible: boolean;
};

export function TerminalWorkspace({
  workspaceRef,
  sidebarCollapsed,
  activeTitle,
  activeSession,
  providerId,
  targetId,
  onToggleSidebar,
  onOpenDetail,
  onOpenNewSession,
  tabs,
  activeTabKey,
  tabsRef,
  onTabsWheel,
  onSelectTab,
  onTabContextMenu,
  onCloseTab,
  focusRequest,
  terminalInputStates,
  onTerminalReady,
  onVendorSwitch,
  onTerminalExit,
  onTerminalInputState,
  systemTerminalOpen,
  activeCwd,
  systemTerminalMinimized,
  systemTerminalCreateSignal,
  onCloseSystemTerminal,
  onToggleSystemTerminalMinimized,
  vendors
}: {
  workspaceRef: RefObject<HTMLElement | null>;
  sidebarCollapsed: boolean;
  activeTitle: string;
  activeSession: AiSession | null;
  providerId: string;
  targetId: string;
  onToggleSidebar: () => void;
  onOpenDetail: (session: AiSession) => void;
  onOpenNewSession: () => void;
  tabs: TerminalTab[];
  activeTabKey: string;
  tabsRef: RefObject<HTMLDivElement | null>;
  onTabsWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onSelectTab: (tabKey: string, sessionId: string) => void;
  onTabContextMenu: (event: MouseEvent<HTMLElement>, tabKey: string) => void;
  onCloseTab: (tabKey: string) => void;
  focusRequest: number;
  terminalInputStates: Record<string, TerminalInputState>;
  onTerminalReady: (tabKey: string, terminalId?: string, vendorId?: string) => void;
  onVendorSwitch: (tabKey: string, vendorId: string, reason: "manual" | "candidate-pool" | "failure") => void;
  onTerminalExit: (tabKey: string, exitCode: number) => void;
  onTerminalInputState: (tabKey: string, state: TerminalInputState) => void;
  systemTerminalOpen: boolean;
  activeCwd?: string;
  systemTerminalMinimized: boolean;
  systemTerminalCreateSignal: number;
  onCloseSystemTerminal: () => void;
  onToggleSystemTerminalMinimized: () => void;
  vendors?: ApiVendor[];
}) {
  return (
    <section className="terminal-workspace" ref={workspaceRef}>
      <section className="detail">
        <div className="detail-main">
          <div className="detail-title-row">
            <button
              className="workspace-sidebar-toggle"
              title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              onClick={onToggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
            </button>
            <h2 title={activeTitle}>{activeTitle}</h2>
          </div>
        </div>
        <div className="actions">
          {activeSession && <button className="secondary" onClick={() => onOpenDetail(activeSession)}>详情</button>}
          {providerId && targetId && <button onClick={onOpenNewSession}>新会话</button>}
        </div>
      </section>
      <TerminalTabs
        tabs={tabs}
        activeTabKey={activeTabKey}
        tabsRef={tabsRef}
        onWheel={onTabsWheel}
        onSelect={onSelectTab}
        onContextMenu={onTabContextMenu}
        onClose={onCloseTab}
      />
      <div className="terminal-stack">
        {tabs.length === 0 ? <div className="empty-terminal">当前无对话</div> : (
          <Suspense fallback={<div className="empty-terminal">正在加载终端...</div>}>
            {tabs.map((tab) => (
              <EmbeddedTerminal
                key={tab.key}
                targetId={tab.targetId}
                sessionId={tab.session?.id}
                cwd={tab.cwd || tab.session?.cwd}
                codexHome={tab.codexHome}
                useCodexCwdFlag={tab.useCodexCwdFlag}
                prompt={tab.prompt}
                cliArgs={tab.cliArgs}
                title={tab.session?.title || tab.title}
                active={tab.key === activeTabKey}
                focusRequest={focusRequest}
                requestedInputMode={terminalInputStates[tab.key]?.mode}
                onReady={(terminalId, vendorId) => onTerminalReady(tab.key, terminalId, vendorId)}
                onVendorSwitch={(vendorId, reason) => onVendorSwitch(tab.key, vendorId, reason)}
                onExit={(exitCode) => onTerminalExit(tab.key, exitCode)}
                onInputModeChange={(state) => onTerminalInputState(tab.key, state)}
                vendors={vendors}
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
            onClose={onCloseSystemTerminal}
            onToggleMinimized={onToggleSystemTerminalMinimized}
          />
        </Suspense>
      )}
    </section>
  );
}
