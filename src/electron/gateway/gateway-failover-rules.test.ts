import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => {
  type Row = Record<string, any>;
  const rows: Row[] = [];
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const database = {
    exec: vi.fn(),
    prepare(sql: string) {
      const normalized = normalize(sql);
      return {
        all() {
          if (normalized.startsWith("SELECT * FROM gateway_failover_rules")) return [...rows];
          if (normalized.startsWith("PRAGMA table_info(gateway_failover_rules)")) return [{ name: "status_codes" }, { name: "priority" }];
          throw new Error(`Unsupported all SQL: ${normalized}`);
        },
        get(...params: unknown[]) {
          if (normalized.startsWith("SELECT * FROM gateway_failover_rules WHERE id = ?")) return rows.find((row) => row.id === params[0]);
          if (normalized.startsWith("SELECT COUNT(*) AS count FROM gateway_failover_rules")) return { count: rows.length };
          throw new Error(`Unsupported get SQL: ${normalized}`);
        },
        run(...params: unknown[]) {
          if (normalized.startsWith("INSERT INTO gateway_failover_rules")) {
            const next = {
              id: params[0], scope: params[1], provider_id: params[2], vendor_id: params[3], pattern: params[4],
              status_codes: params[5], custom_response_status: params[6], custom_response_body: params[7], enabled: params[8], created_at: params[9], updated_at: params[10]
            };
            const index = rows.findIndex((row) => row.id === next.id);
            if (index >= 0) rows[index] = next;
            else rows.push(next);
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (normalized.startsWith("DELETE FROM gateway_failover_rules")) {
            const index = rows.findIndex((row) => row.id === params[0]);
            if (index >= 0) rows.splice(index, 1);
            return { changes: index >= 0 ? 1 : 0, lastInsertRowid: 0 };
          }
          if (normalized.startsWith("UPDATE gateway_failover_rules SET enabled")) {
            const row = rows.find((item) => item.id === params[2]);
            if (row) row.enabled = params[0];
            return { changes: row ? 1 : 0, lastInsertRowid: 0 };
          }
          throw new Error(`Unsupported run SQL: ${normalized}`);
        }
      };
    }
  };
  return { rows, database };
});

vi.mock("../core/app-database", () => ({
  readAppDatabase: async (reader: (db: typeof databaseMock.database) => unknown) => reader(databaseMock.database),
  updateAppDatabase: async (updater: (db: typeof databaseMock.database) => unknown) => updater(databaseMock.database)
}));

import {
  deleteGatewayFailoverRule,
  getGatewayFailoverCustomResponse,
  invalidateGatewayFailoverRuleSnapshot,
  listGatewayFailoverRules,
  matchesGatewayFailoverError,
  saveGatewayFailoverRule,
  setGatewayFailoverRuleEnabled
} from "./gateway-failover-rules";

describe("gateway failover rules", () => {
  beforeEach(() => {
    databaseMock.rows.splice(0, databaseMock.rows.length);
    invalidateGatewayFailoverRuleSnapshot();
  });

  it("默认识别容量错误，并允许 Provider 级自定义规则", async () => {
    await listGatewayFailoverRules();
    expect(databaseMock.database.exec).toHaveBeenCalledWith("DROP INDEX IF EXISTS idx_gateway_failover_rules_scope");
    expect(databaseMock.database.exec).toHaveBeenCalledWith("ALTER TABLE gateway_failover_rules DROP COLUMN priority");
    await expect(matchesGatewayFailoverError("Selected model is at capacity", "codex", "vendor-a")).resolves.toBe(true);
    await saveGatewayFailoverRule({ scope: "provider", providerId: "codex", pattern: "quota exhausted" });
    await expect(matchesGatewayFailoverError("quota exhausted", "codex", "vendor-a")).resolves.toBe(true);
    await expect(matchesGatewayFailoverError("quota exhausted", "gemini", "vendor-b")).resolves.toBe(false);
  });

  it("支持供应商级规则启停和删除", async () => {
    const saved = await saveGatewayFailoverRule({ scope: "vendor", providerId: "codex", vendorId: "vendor-a", pattern: "capacity reached" });
    await expect(matchesGatewayFailoverError("capacity reached", "codex", "vendor-a")).resolves.toBe(true);
    await setGatewayFailoverRuleEnabled(saved.id, false);
    await expect(matchesGatewayFailoverError("capacity reached", "codex", "vendor-a")).resolves.toBe(false);
    await deleteGatewayFailoverRule(saved.id);
    await expect(listGatewayFailoverRules()).resolves.toEqual([]);
  });

  it("支持状态码与错误文本组合匹配，单条规则内条件为 AND", async () => {
    await saveGatewayFailoverRule({
      scope: "provider",
      providerId: "claude",
      pattern: "credit insufficient balance",
      statusCodes: [400, 402, 402]
    });

    await expect(matchesGatewayFailoverError("credit insufficient balance", "claude", "vendor-a", 400)).resolves.toBe(true);
    await expect(matchesGatewayFailoverError("credit insufficient balance", "claude", "vendor-a", 402)).resolves.toBe(true);
    await expect(matchesGatewayFailoverError("invalid request", "claude", "vendor-a", 400)).resolves.toBe(false);
    await expect(matchesGatewayFailoverError("credit insufficient balance", "claude", "vendor-a", 403)).resolves.toBe(false);
    await expect(matchesGatewayFailoverError("credit insufficient balance", "codex", "vendor-a", 400)).resolves.toBe(false);
    await expect(listGatewayFailoverRules()).resolves.toMatchObject([{ statusCodes: [400, 402] }]);
  });

  it("支持仅配置状态码的规则并拒绝空规则或非错误状态码", async () => {
    await saveGatewayFailoverRule({ scope: "global", statusCodes: [418] });
    await expect(matchesGatewayFailoverError(undefined, "claude", "vendor-a", 418)).resolves.toBe(true);
    await expect(saveGatewayFailoverRule({ scope: "global" })).rejects.toThrow("至少配置错误文本或 HTTP 状态码");
    await expect(saveGatewayFailoverRule({ scope: "global", statusCodes: [200] })).rejects.toThrow("400 到 599");
  });

  it("校验并读取自定义最终响应", async () => {
    const saved = await saveGatewayFailoverRule({
      scope: "global",
      pattern: "credit insufficient balance",
      customResponseStatus: 503,
      customResponseBody: '{"error":"provider unavailable"}'
    });
    expect(saved).toMatchObject({ customResponseStatus: 503, customResponseBody: '{"error":"provider unavailable"}' });
    await expect(getGatewayFailoverCustomResponse("credit insufficient balance: balance=2", "codex", undefined, 400))
      .resolves.toMatchObject({ customResponseStatus: 503, customResponseBody: '{"error":"provider unavailable"}' });
    await expect(saveGatewayFailoverRule({ scope: "global", pattern: "quota", customResponseStatus: 503 })).rejects.toThrow("必须同时配置");
    await expect(saveGatewayFailoverRule({ scope: "global", pattern: "quota", customResponseStatus: 503, customResponseBody: "invalid" })).rejects.toThrow("合法 JSON");
  });

  it("拒绝空规则和无效作用域组合", async () => {
    await expect(saveGatewayFailoverRule({ scope: "global", pattern: " " })).rejects.toThrow("至少配置错误文本或 HTTP 状态码");
    await expect(saveGatewayFailoverRule({ scope: "provider", pattern: "quota" })).rejects.toThrow("必须指定 Provider");
    await expect(saveGatewayFailoverRule({ scope: "global", providerId: "codex", pattern: "quota" })).rejects.toThrow("不能指定 Provider");
  });
});
