import type { RefObject } from "react";
import type { AiSession } from "./types";
import { UsageDetailsPopover } from "./UsageDetails";

type StatusText = { label: string; title: string };

// 底部状态栏：会话编号 / 更新时间 / 工作目录 / 模型 / Token / 上下文，以及终端输入模式切换。
// 从 App.tsx 的内联 footer JSX 抽出为展示组件。
export function StatusBar({
  session,
  updatedAt,
  cwd,
  model,
  tokenUsage,
  contextUsage,
  contextLevel,
  supportsUsage,
  usageDetailsOpen,
  usageDetailsRef,
  onToggleUsageDetails,
  terminalInputMode,
  terminalInputButtonLabel,
  canToggleTerminalInput,
  onToggleTerminalInputMode
}: {
  session: AiSession | null;
  updatedAt: string;
  cwd: string;
  model: StatusText;
  tokenUsage: StatusText;
  contextUsage: StatusText;
  contextLevel: string;
  supportsUsage: boolean;
  usageDetailsOpen: boolean;
  usageDetailsRef: RefObject<HTMLDivElement | null>;
  onToggleUsageDetails: () => void;
  terminalInputMode: "composer" | "terminal" | undefined;
  terminalInputButtonLabel: string;
  canToggleTerminalInput: boolean;
  onToggleTerminalInputMode: () => void;
}) {
  return (
    <footer className="app-statusbar" aria-label="当前状态">
      <div className="statusbar-left">
        <div className="status-item">
          <span>会话编号</span>
          <code>{session?.id || "-"}</code>
        </div>
        <div className="status-item">
          <span>更新时间</span>
          <strong>{updatedAt}</strong>
        </div>
        <div className="status-item status-item-wide">
          <span>工作目录</span>
          <strong title={cwd}>{cwd}</strong>
        </div>
      </div>
      <div className="statusbar-right">
        <button
          type="button"
          className={`status-input-toggle ${terminalInputMode === "terminal" ? "active" : ""}`}
          onClick={onToggleTerminalInputMode}
          disabled={!canToggleTerminalInput}
          title={terminalInputMode === "composer" ? "切换到终端原生输入" : "切换到自管输入框"}
        >
          {terminalInputButtonLabel}
        </button>
        <div className="status-item">
          <span>模型</span>
          <strong title={model.title}>{model.label}</strong>
        </div>
        {supportsUsage && (
          <div className="status-usage" ref={usageDetailsRef}>
            <button
              type="button"
              className={`status-usage-trigger context-${contextLevel}`}
              aria-haspopup="dialog"
              aria-expanded={usageDetailsOpen}
              onClick={onToggleUsageDetails}
            >
              <span className="status-item">
                <span>Token</span>
                <strong title={tokenUsage.title}>{tokenUsage.label}</strong>
              </span>
              <span className="status-item">
                <span>上下文</span>
                <strong title={contextUsage.title}>{contextUsage.label}</strong>
              </span>
            </button>
            {usageDetailsOpen && <UsageDetailsPopover session={session} />}
          </div>
        )}
      </div>
    </footer>
  );
}
