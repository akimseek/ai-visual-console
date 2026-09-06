import { describe, expect, it } from "vitest";
import { formatGatewayUsageDuration, getGatewayUsageDateRange } from "./gateway-usage-dialog";

describe("Gateway 用量明细", () => {
  it("将平均耗时按秒显示并保留两位小数", () => {
    expect(formatGatewayUsageDuration(1250)).toBe("1.25 秒");
    expect(formatGatewayUsageDuration(0)).toBe("0.00 秒");
    expect(formatGatewayUsageDuration(undefined)).toBe("-");
  });

  it("自定义日期范围使用本地自然日边界", () => {
    const start = new Date("2026-09-01T00:00:00");
    const end = new Date("2026-09-03T23:59:59.999");
    expect(getGatewayUsageDateRange("custom", "2026-09-01", "2026-09-03")).toEqual({
      periodStart: start.toISOString(),
      periodEnd: end.toISOString()
    });
  });
});
