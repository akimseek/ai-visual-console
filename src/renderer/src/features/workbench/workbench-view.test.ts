import { describe, expect, it } from "vitest";
import { formatFailureDetail, formatGatewayHealthDetail, formatVendorSwitch, formatWorkbenchRefreshTime, getLastCompleteWorkbenchRefresh } from "./workbench-view";

describe("workbench vendor switch", () => {
  it("将故障切换格式化为可读的工作台摘要", () => {
    expect(formatVendorSwitch({ vendorId: "vendor-a", reason: "failure", switchedAt: new Date(2026, 8, 5, 9, 7, 3).getTime() }, "主供应商")).toEqual({
      reason: "故障切换",
      detail: "09:07:03 · 主供应商"
    });
  });

  it("将候选池导致的变更显示为中性路由调整", () => {
    expect(formatVendorSwitch({ vendorId: "vendor-a", reason: "candidate-pool", switchedAt: new Date(2026, 8, 5, 9, 7, 3).getTime() }, "主供应商").reason).toBe("路由调整");
  });

  it("在供应商已删除时仍保留失败日志的时间摘要", () => {
    expect(formatFailureDetail({ vendorId: "vendor-a", providerId: "codex", outcome: "error", createdAt: new Date(2026, 8, 5, 9, 7, 3).toISOString() }, [])).toBe("09:07:03 · 已删除供应商");
  });

  it("显示熔断剩余时间，避免用户误以为供应商永久不可用", () => {
    const now = new Date(2026, 8, 5, 9, 1, 15);
    expect(formatGatewayHealthDetail({ status: "open", circuitUntil: new Date(2026, 8, 5, 9, 2, 30).toISOString() }, now)).toBe("熔断剩余 1 分 15 秒");
  });

  it("非熔断状态显示最近失败时间", () => {
    expect(formatGatewayHealthDetail({ status: "degraded", lastFailureAt: new Date(2026, 8, 5, 9, 7).toISOString() }, new Date(2026, 8, 5, 9, 8))).toBe("最近失败 09-05 09:07");
  });

  it("仅在健康与用量均有成功快照时标记完整刷新", () => {
    const healthUpdatedAt = new Date(2026, 8, 5, 9, 8, 3);
    const usageUpdatedAt = new Date(2026, 8, 5, 9, 8, 5);
    expect(getLastCompleteWorkbenchRefresh(healthUpdatedAt, usageUpdatedAt)).toEqual(healthUpdatedAt);
    expect(getLastCompleteWorkbenchRefresh(healthUpdatedAt, null)).toBeNull();
  });

  it("区分首次读取中的刷新状态和已有快照的更新时间", () => {
    expect(formatWorkbenchRefreshTime(null, true)).toBe("正在更新");
    expect(formatWorkbenchRefreshTime(new Date(2026, 8, 5, 9, 8, 3), false)).toBe("更新 09:08:03");
  });
});
