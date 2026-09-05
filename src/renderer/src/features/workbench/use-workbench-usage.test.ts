import { describe, expect, it } from "vitest";
import { formatGatewayFailure, formatGatewayUsageSummary, getTodayGatewayUsagePeriod } from "./use-workbench-usage";

describe("workbench gateway usage helpers", () => {
  it("使用本地零点作为当天统计起点", () => {
    const now = new Date("2026-09-05T18:30:00+08:00");
    const expectedStart = new Date(now);
    expectedStart.setHours(0, 0, 0, 0);
    expect(getTodayGatewayUsagePeriod(now)).toEqual({
      periodStart: expectedStart.toISOString(),
      periodEnd: now.toISOString()
    });
  });

  it("格式化请求、成功率、切换、Token 与费用", () => {
    expect(formatGatewayUsageSummary({
      requestCount: 12,
      successCount: 11,
      failureCount: 1,
      switchedCount: 2,
      totalTokens: 12_340,
      costUsd: 0.45678,
      periodStart: "2026-09-04T16:00:00.000Z",
      periodEnd: "2026-09-05T10:30:00.000Z"
    })).toEqual({
      requestCount: "12",
      successRate: "91.7%",
      switchedCount: "2",
      totalTokens: "12K",
      cost: "$0.4568"
    });
  });

  it("仅输出安全的 Gateway 异常分类", () => {
    expect(formatGatewayFailure({ vendorId: "vendor-a", providerId: "codex", outcome: "error", upstreamStatus: 429, createdAt: "2026-09-05T09:00:00.000Z" })).toBe("请求失败");
    expect(formatGatewayFailure({ vendorId: "vendor-a", providerId: "codex", outcome: "timeout", createdAt: "2026-09-05T09:00:00.000Z" })).toBe("请求超时");
  });
});
