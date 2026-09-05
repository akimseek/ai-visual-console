import type { MouseEvent, RefObject, WheelEvent } from "react";
import { X } from "lucide-react";

type TerminalTabInfo = { key: string; title: string; session?: { id: string } | null };

// 终端标签条：每个已打开会话一个标签，支持选中、右键菜单、关闭、横向滚轮。
// 从 App.tsx 的内联 JSX 抽出为展示组件。
export function TerminalTabs({
  tabs,
  activeTabKey,
  tabsRef,
  onWheel,
  onSelect,
  onContextMenu,
  onClose
}: {
  tabs: TerminalTabInfo[];
  activeTabKey: string;
  tabsRef: RefObject<HTMLDivElement | null>;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onSelect: (tabKey: string, sessionId: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, tabKey: string) => void;
  onClose: (tabKey: string) => void;
}) {
  return (
    <div
      className="terminal-tabs"
      ref={tabsRef}
      role="tablist"
      aria-label="已打开会话"
      onWheel={onWheel}
    >
      {tabs.map((tab) => {
        const label = truncateTabTitle(tab.title);
        return (
          <button
            key={tab.key}
            className={tab.key === activeTabKey ? "active" : ""}
            role="tab"
            onContextMenu={(event) => onContextMenu(event, tab.key)}
            onClick={() => onSelect(tab.key, tab.session?.id || "")}
            title={tab.title}
            >
              <span>{label}</span>
            <span
              className="terminal-tab-close"
              role="button"
              tabIndex={0}
              title="关闭"
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.key);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onClose(tab.key);
              }}
            >
              <X aria-hidden="true" size={14} strokeWidth={2} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function truncateTabTitle(value: string, maxLength = 40) {
  const characters = Array.from(value);
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}...` : value;
}
