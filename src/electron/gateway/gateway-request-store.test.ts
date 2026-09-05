import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会提升到模块初始化之前，mock 依赖也必须在提升阶段创建。
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  prepare: vi.fn(),
  readAppDatabase: vi.fn(),
  updateAppDatabase: vi.fn()
}));

vi.mock("../core/app-database", () => ({
  readAppDatabase: mocks.readAppDatabase,
  updateAppDatabase: mocks.updateAppDatabase
}));

import { getGatewayFailureDiagnosticsPage, getRecentGatewayFailures } from "./gateway-request-store";

describe("recent gateway failures", () => {
  beforeEach(() => {
    mocks.exec.mockReset();
    mocks.prepare.mockReset();
    mocks.readAppDatabase.mockReset();
    mocks.updateAppDatabase.mockReset();
    mocks.updateAppDatabase.mockImplementation(async (callback: (db: { exec: typeof mocks.exec }) => unknown) => callback({ exec: mocks.exec }));
    mocks.readAppDatabase.mockImplementation((callback: (db: { prepare: typeof mocks.prepare }) => unknown) => callback({ prepare: mocks.prepare }));
  });

  it("仅返回最近三条超时或失败请求的安全摘要", async () => {
    mocks.prepare.mockReturnValue({
      all: () => [
        { vendor_id: "vendor-a", provider_id: "codex", upstream_status: 429, outcome: "error", retry_count: 2, duration_ms: 1200, error_code: "HTTP_429", error_message: "上游限流", created_at: "2026-09-05T08:00:00.000Z" },
        { vendor_id: "vendor-b", provider_id: "claude", upstream_status: null, outcome: "timeout", retry_count: 0, duration_ms: 5000, error_code: null, error_message: null, created_at: "2026-09-05T07:59:00.000Z" }
      ]
    });

    await expect(getRecentGatewayFailures()).resolves.toEqual([
      { vendorId: "vendor-a", providerId: "codex", outcome: "error", upstreamStatus: 429, retryCount: 2, durationMs: 1200, errorCode: "HTTP_429", errorMessage: "上游限流", createdAt: "2026-09-05T08:00:00.000Z" },
      { vendorId: "vendor-b", providerId: "claude", outcome: "timeout", retryCount: 0, durationMs: 5000, createdAt: "2026-09-05T07:59:00.000Z" }
    ]);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.stringContaining("LIMIT ?"));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.stringContaining("outcome IN ('error', 'timeout')"));
  });

  it("按页读取异常诊断并限制每页最大条数", async () => {
    mocks.prepare
      .mockReturnValueOnce({ get: () => ({ total: 21 }) })
      .mockReturnValueOnce({ all: () => [{ vendor_id: "vendor-a", provider_id: "codex", outcome: "error", retry_count: 1, duration_ms: 900, error_code: "E_FAIL", error_message: "连接失败", created_at: "2026-09-05T08:00:00.000Z" }] });

    await expect(getGatewayFailureDiagnosticsPage(2, 100, "vendor-a", "error")).resolves.toEqual({
      items: [{ vendorId: "vendor-a", providerId: "codex", outcome: "error", retryCount: 1, durationMs: 900, errorCode: "E_FAIL", errorMessage: "连接失败", createdAt: "2026-09-05T08:00:00.000Z" }],
      total: 21,
      page: 2,
      pageSize: 50
    });
    expect(mocks.prepare).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT ? OFFSET ?"));
    expect(mocks.prepare).toHaveBeenNthCalledWith(1, expect.stringContaining("vendor_id = ?"));
    expect(mocks.prepare).toHaveBeenNthCalledWith(1, expect.stringContaining("outcome = ?"));
  });

  it("将时间范围加入总数和分页查询", async () => {
    mocks.prepare
      .mockReturnValueOnce({ get: () => ({ total: 1 }) })
      .mockReturnValueOnce({ all: () => [] });

    await getGatewayFailureDiagnosticsPage(1, 10, "", "", "2026-09-01T00:00:00.000Z", "2026-09-05T23:59:59.999Z");
    expect(mocks.prepare).toHaveBeenNthCalledWith(1, expect.stringContaining("created_at >= ?"));
    expect(mocks.prepare).toHaveBeenNthCalledWith(1, expect.stringContaining("created_at <= ?"));
  });
});
