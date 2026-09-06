import { describe, expect, it } from "vitest";
import { aggregateGatewayUsage } from "./gateway-usage";

describe("Gateway 用量聚合", () => {
  it("按供应商和模型累加请求、Token、费用与耗时", () => {
    const report = aggregateGatewayUsage([
      {
        vendorId: "vendor-a",
        vendorName: "主供应商",
        providerId: "codex",
        model: "gpt-5",
        outcome: "ok",
        durationMs: 100,
        retryCount: 0,
        switched: false,
        usageJson: JSON.stringify({ inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.12 })
      },
      {
        vendorId: "vendor-a",
        vendorName: "主供应商",
        providerId: "codex",
        model: "gpt-5",
        outcome: "error",
        durationMs: 300,
        retryCount: 2,
        switched: true,
        usageJson: JSON.stringify({ inputTokens: 200, outputTokens: 80, totalTokens: 280, costUsd: 0.2 })
      },
      {
        vendorId: "vendor-b",
        vendorName: "备用供应商",
        providerId: "qoder",
        model: "qwen3",
        outcome: "timeout",
        durationMs: 500,
        retryCount: 1,
        switched: true,
        usageJson: null
      }
    ], "2026-09-06T00:00:00.000Z", "2026-09-06T23:59:59.999Z");

    expect(report.summary).toMatchObject({
      requestCount: 3,
      successCount: 1,
      failureCount: 2,
      switchedCount: 2,
      retryCount: 3,
      inputTokens: 300,
      outputTokens: 130,
      totalTokens: 430,
      costUsd: 0.32,
      averageDurationMs: 300,
      periodStart: "2026-09-06T00:00:00.000Z",
      periodEnd: "2026-09-06T23:59:59.999Z"
    });
    expect(report.vendors[0]).toMatchObject({ key: "vendor-a", label: "主供应商", requestCount: 2, retryCount: 2, totalTokens: 430, costUsd: 0.32, averageDurationMs: 200 });
    expect(report.vendors[1]).toMatchObject({ key: "vendor-b", label: "备用供应商", requestCount: 1, retryCount: 1, averageDurationMs: 500 });
    expect(report.models[0]).toMatchObject({ key: "codex:gpt-5", label: "gpt-5", requestCount: 2, totalTokens: 430 });
  });

  it("空数据和损坏的 usage 不会生成虚假 Token 或费用", () => {
    const report = aggregateGatewayUsage([{
      vendorId: "vendor-a",
      vendorName: "主供应商",
      providerId: "codex",
      outcome: "error",
      durationMs: 10,
      retryCount: 0,
      switched: false,
      usageJson: "{invalid"
    }], "", "");

    expect(report.summary).toMatchObject({ requestCount: 1, failureCount: 1, averageDurationMs: 10 });
    expect(report.summary.inputTokens).toBeUndefined();
    expect(report.summary.costUsd).toBeUndefined();
    expect(report.models[0].label).toBe("未标注模型");
  });
});
