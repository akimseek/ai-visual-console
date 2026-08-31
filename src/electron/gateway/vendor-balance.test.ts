import { describe, expect, it, vi } from "vitest";
vi.mock("../vendors/vendor-manager", () => ({ listApiVendors: vi.fn() }));
vi.mock("../core/app-database", () => ({
  readAppDatabase: vi.fn(),
  updateAppDatabase: vi.fn()
}));

import { parseGenericBalance, parseNewApiBalance } from "./vendor-balance";

describe("vendor balance parsers", () => {
  it("解析通用接口的嵌套余额字段", () => {
    expect(parseGenericBalance({ data: { balance: "12.5", unit: "USD" } })).toMatchObject({
      remaining: 12.5,
      unit: "USD",
      isValid: true
    });
  });

  it("解析 New API quota 并换算额度", () => {
    expect(parseNewApiBalance({ data: { quota: 1_000_000, used_quota: 250_000 } })).toMatchObject({
      total: 2.5,
      used: 0.5,
      remaining: 2,
      unit: "额度",
      isValid: true
    });
  });

  it("无法识别余额字段时返回空结果", () => {
    expect(parseGenericBalance({ data: { message: "ok" } })).toBeNull();
    expect(parseNewApiBalance({ data: { used_quota: 1 } })).toBeNull();
  });
});
