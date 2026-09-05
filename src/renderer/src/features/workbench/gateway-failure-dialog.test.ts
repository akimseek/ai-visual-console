import { describe, expect, it } from "vitest";
import { formatDiagnosticDuration, formatDiagnosticTime, getGatewayFailureDateRange } from "./gateway-failure-dialog";
import { formatGatewayFailure } from "./use-workbench-usage";

describe("gateway failure diagnostics formatters", () => {
  it("使用本地时间格式化诊断记录", () => {
    expect(formatDiagnosticTime(new Date(2026, 8, 5, 9, 7, 3).toISOString())).toBe("2026-09-05 09:07:03");
  });

  it("将耗时格式化为紧凑的毫秒或秒", () => {
    expect(formatDiagnosticDuration(520)).toBe("520 ms");
    expect(formatDiagnosticDuration(1_250)).toBe("1.3 s");
    expect(formatDiagnosticDuration(-1)).toBe("-");
  });

  it("失败结果不被上游 HTTP 200 状态误标为成功", () => {
    expect(formatGatewayFailure({ vendorId: "vendor-a", providerId: "codex", outcome: "error", upstreamStatus: 200, createdAt: "" })).toBe("请求失败");
  });

  it("按本地自然日生成今天和近七天的查询边界", () => {
    const now = new Date(2026, 8, 5, 15, 30, 0);
    const today = getGatewayFailureDateRange("today", "", "", now);
    expect(today.periodStart).toBe(new Date(2026, 8, 5, 0, 0, 0).toISOString());
    expect(today.periodEnd).toBe(now.toISOString());
    const sevenDays = getGatewayFailureDateRange("7d", "", "", now);
    expect(sevenDays.periodStart).toBe(new Date(2026, 7, 30, 0, 0, 0).toISOString());
  });

  it("自定义日期包含结束日且拒绝反向日期", () => {
    const range = getGatewayFailureDateRange("custom", "2026-09-01", "2026-09-05");
    expect(range.periodStart).toBe(new Date(2026, 8, 1, 0, 0, 0).toISOString());
    expect(range.periodEnd).toBe(new Date(2026, 8, 5, 23, 59, 59, 999).toISOString());
    expect(getGatewayFailureDateRange("custom", "2026-09-06", "2026-09-05").error).toBe("起始日期不能晚于结束日期。");
  });
});
