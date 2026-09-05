import type { AiProviderId, AiProviderSummary, AiTarget } from "../types";
import { CircleHelp, RefreshCw } from "lucide-react";
import { IconButton } from "./icon-button";

// 侧栏头部：标题、平台状态/刷新按钮、平台与目标选择器。从 App.tsx 的内联 JSX 抽出为展示组件。
export function SidebarHeader({
  providers,
  providerId,
  onProviderChange,
  targets,
  targetId,
  onTargetChange,
  onOpenStatus,
  onRefresh
}: {
  providers: AiProviderSummary[];
  providerId: AiProviderId | "";
  onProviderChange: (id: AiProviderId | "") => void;
  targets: AiTarget[];
  targetId: string;
  onTargetChange: (id: string) => void;
  onOpenStatus: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <header className="sidebar-header">
        <div>
          <h1>AI 控制台</h1>
        </div>
        <div className="sidebar-actions">
          <IconButton icon={CircleHelp} label="平台状态" disabled={!providerId} onClick={onOpenStatus} />
          <IconButton icon={RefreshCw} label="刷新目标" disabled={!providerId} onClick={onRefresh} />
        </div>
      </header>

      <div className="target-picker">
        <span>平台</span>
        <select value={providerId} onChange={(event) => onProviderChange(event.target.value as AiProviderId | "")}>
          <option value="">请选择平台</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </div>

      <div className="target-picker">
        <span>目标</span>
        <select value={targetId} disabled={!providerId || targets.length === 0} onChange={(event) => onTargetChange(event.target.value)}>
          {!providerId && <option value="">请先选择平台</option>}
          {providerId && targets.length === 0 && <option value="">暂无可用目标</option>}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
