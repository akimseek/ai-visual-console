import { afterEach, describe, expect, it, vi } from "vitest";

const readAppDatabaseMock = vi.hoisted(() => vi.fn());
const updateAppDatabaseMock = vi.hoisted(() => vi.fn());

vi.mock("../core/app-database", () => ({
  readAppDatabase: readAppDatabaseMock,
  updateAppDatabase: updateAppDatabaseMock
}));
vi.mock("../core/settings", () => ({
  getGatewayCircuitDurationSeconds: vi.fn().mockResolvedValue(60),
  getGatewayCircuitFailureThreshold: vi.fn().mockResolvedValue(3)
}));

import { chooseNextVendor, hydrateGatewayVendorHealth } from "./gateway-resilience";

describe("gateway resilience", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("并发初始化健康状态时只读取一次数据库", async () => {
    const database = {
      exec: vi.fn(),
      prepare: vi.fn(() => ({ all: vi.fn(() => []) }))
    };
    updateAppDatabaseMock.mockImplementation(async (updater: (db: typeof database) => unknown) => updater(database));
    readAppDatabaseMock.mockImplementation(async (reader: (db: typeof database) => unknown) => reader(database));

    await Promise.all([hydrateGatewayVendorHealth(), hydrateGatewayVendorHealth()]);

    expect(readAppDatabaseMock).toHaveBeenCalledTimes(1);
    expect(database.prepare).toHaveBeenCalledWith("SELECT * FROM gateway_vendor_health");
  });

  it("按 sort 环形遍历同一 Provider 的完整候选池", () => {
    const vendors = Array.from({ length: 8 }, (_, index) => ({
      id: `vendor-${index + 1}`,
      providerId: "codex" as const,
      name: `vendor-${index + 1}`,
      apiKey: `key-${index + 1}`,
      apiBaseUrl: "https://example.com/v1",
      configs: [],
      enabled: true,
      sort: index + 1,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    const attempted = new Set<string>();
    const order: string[] = [];
    let current = vendors[0].id;
    for (let index = 0; index < vendors.length - 1; index += 1) {
      attempted.add(current);
      const next = chooseNextVendor(vendors, "codex", current, attempted);
      expect(next).toBeDefined();
      current = next!.id;
      order.push(current);
    }
    expect(order).toEqual(vendors.slice(1).map((vendor) => vendor.id));
    expect(chooseNextVendor(vendors, "codex", current, new Set(vendors.map((vendor) => vendor.id)))).toBeUndefined();
  });
});
