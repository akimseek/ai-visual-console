import { useState } from "react";
import type { AiTarget, ApiVendor } from "../../types";
import type { NoticeState } from "../../hooks/use-app-notice";

type SetNotice = (message: string, action?: { label: string; onClick: () => void }, tone?: NoticeState["tone"]) => void;

type VendorSwitchReason = "manual" | "candidate-pool" | "failure";

export type TabVendorSwitch = {
  vendorId: string;
  reason: VendorSwitchReason;
  switchedAt: number;
};

// 终端标签与 Gateway 供应商的绑定：ready/switched 事件写入映射，关标签时清理；
// 状态栏展示名优先取当前标签绑定的供应商，无绑定时回退到候选池首个启用项。
export function useTabVendors(options: {
  vendors: ApiVendor[];
  loadApiVendors: (force: boolean) => Promise<void>;
  setNotice: SetNotice;
  activeTabKey?: string;
  providerId: string;
  selectedTarget: AiTarget | undefined;
}) {
  const { vendors, loadApiVendors, setNotice, activeTabKey, providerId, selectedTarget } = options;
  const [vendorByTabKey, setVendorByTabKey] = useState<Record<string, string>>({});
  const [lastSwitchByTabKey, setLastSwitchByTabKey] = useState<Record<string, TabVendorSwitch>>({});

  const activeVendorId = activeTabKey ? vendorByTabKey[activeTabKey] : undefined;
  const activeVendorSwitch = activeTabKey ? lastSwitchByTabKey[activeTabKey] : undefined;
  const activeVendorName = activeVendorId
    ? vendors.find((vendor) => vendor.id === activeVendorId)?.name || ""
    : vendors.find((vendor) => vendor.providerId === (selectedTarget?.provider || providerId) && vendor.enabled)?.name || "";

  function bindTabVendor(tabKey: string, vendorId?: string) {
    if (!vendorId) return;
    setVendorByTabKey((current) => ({ ...current, [tabKey]: vendorId }));
    if (!vendors.some((vendor) => vendor.id === vendorId)) void loadApiVendors(false);
  }

  function releaseTabVendor(tabKey: string) {
    setVendorByTabKey((current) => {
      if (!(tabKey in current)) return current;
      const next = { ...current };
      delete next[tabKey];
      return next;
    });
    // 切换记录只服务于仍打开的标签，关闭后立即释放，避免工作台显示过期会话信息。
    setLastSwitchByTabKey((current) => {
      if (!(tabKey in current)) return current;
      const next = { ...current };
      delete next[tabKey];
      return next;
    });
  }

  function handleVendorSwitch(tabKey: string, vendorId: string, reason: VendorSwitchReason) {
    bindTabVendor(tabKey, vendorId);
    // Gateway 事件不落盘；工作台仅展示当前应用运行期间该标签最近一次实际路由变更。
    setLastSwitchByTabKey((current) => ({
      ...current,
      [tabKey]: { vendorId, reason, switchedAt: Date.now() }
    }));
    if (reason === "candidate-pool") return;
    const vendor = vendors.find((item) => item.id === vendorId);
    setNotice(reason === "failure"
      ? `当前请求异常，已自动切换供应商${vendor ? `：${vendor.name}` : ""}。`
      : `已切换供应商${vendor ? `：${vendor.name}` : ""}。`);
  }

  return { activeVendorId, activeVendorName, activeVendorSwitch, bindTabVendor, releaseTabVendor, handleVendorSwitch };
}
