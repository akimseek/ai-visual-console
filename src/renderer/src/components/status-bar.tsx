import type { AiSession, ApiVendor, VendorRouteMode } from "../types";
import { VendorRoutePicker } from "./vendor-route-picker";

// 底部状态栏：会话编号 / 更新时间 / 工作目录 / 当前供应商，以及终端输入模式切换。
// 从 App.tsx 的内联 footer JSX 抽出为展示组件。
export function StatusBar({
  session,
  updatedAt,
  cwd,
  vendorId,
  vendorName,
  vendorMode,
  routeVendors,
  vendorRouteDisabled,
  onSelectVendor,
  onSetVendorMode,
  terminalInputMode,
  terminalInputButtonLabel,
  canToggleTerminalInput,
  onToggleTerminalInputMode
}: {
  session: AiSession | null;
  updatedAt: string;
  cwd: string;
  vendorId?: string;
  vendorName: string;
  vendorMode: VendorRouteMode;
  routeVendors: ApiVendor[];
  vendorRouteDisabled: boolean;
  onSelectVendor: (vendorId: string) => Promise<void>;
  onSetVendorMode: (mode: VendorRouteMode) => Promise<void>;
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
          <code title={session?.id || undefined}>{session?.id || "-"}</code>
        </div>
        <div className="status-item">
          <span>更新时间</span>
          <strong>{updatedAt}</strong>
        </div>
        <div className="status-item status-item-wide">
          <span>工作目录</span>
          <strong title={cwd}>{cwd}</strong>
        </div>
        <div className="status-item status-item-wide">
          <span>当前供应商</span>
          <VendorRoutePicker
            vendorId={vendorId}
            vendorName={vendorName}
            mode={vendorMode}
            vendors={routeVendors}
            disabled={vendorRouteDisabled}
            onSelectVendor={onSelectVendor}
            onSetMode={onSetVendorMode}
          />
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
      </div>
    </footer>
  );
}
