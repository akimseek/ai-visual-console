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

import { hydrateGatewayVendorHealth } from "./gateway-resilience";

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
});
