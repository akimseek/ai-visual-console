import crypto from "node:crypto";
import type {
  AiProviderId,
  GatewayFailoverRule,
  GatewayFailoverRuleInput,
  GatewayFailoverRuleScope
} from "../../shared/types";
import { GATEWAY_FAILOVER_DEFAULT_PATTERNS, GATEWAY_FAILOVER_DEFAULT_STATUS_CODES, GATEWAY_FAILOVER_RULE_LIMITS } from "../../shared/constants";
import { matchesGatewayFailoverCondition } from "../../shared/gateway-failover";
import { readAppDatabase, updateAppDatabase, type SqliteDatabase } from "../core/app-database";

type RuleRow = {
  id: string;
  scope: GatewayFailoverRuleScope;
  provider_id: AiProviderId | null;
  vendor_id: string | null;
  pattern: string;
  status_codes: string;
  custom_response_status: number | null;
  custom_response_body: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

let schemaPromise: Promise<void> | null = null;
let snapshot: GatewayFailoverRule[] | null = null;
let loading: Promise<GatewayFailoverRule[]> | null = null;
let snapshotVersion = 0;
let loadingVersion = -1;

export async function ensureGatewayFailoverRuleSchema() {
  if (!schemaPromise) {
    schemaPromise = updateAppDatabase((db) => initializeSchema(db)).finally(() => {
      schemaPromise = null;
    });
  }
  await schemaPromise;
}

function initializeSchema(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_failover_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      provider_id TEXT,
      vendor_id TEXT,
      pattern TEXT NOT NULL DEFAULT '',
      status_codes TEXT NOT NULL DEFAULT '',
      custom_response_status INTEGER,
      custom_response_body TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = db.prepare("PRAGMA table_info(gateway_failover_rules)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "status_codes")) {
    db.exec("ALTER TABLE gateway_failover_rules ADD COLUMN status_codes TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === "custom_response_status")) {
    db.exec("ALTER TABLE gateway_failover_rules ADD COLUMN custom_response_status INTEGER");
  }
  if (!columns.some((column) => column.name === "custom_response_body")) {
    db.exec("ALTER TABLE gateway_failover_rules ADD COLUMN custom_response_body TEXT");
  }
  if (columns.some((column) => column.name === "priority")) {
    db.exec("DROP INDEX IF EXISTS idx_gateway_failover_rules_scope");
    db.exec("ALTER TABLE gateway_failover_rules DROP COLUMN priority");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gateway_failover_rules_scope
      ON gateway_failover_rules(scope, provider_id, vendor_id, enabled);
  `);
}

export async function listGatewayFailoverRules() {
  const rules = await getGatewayFailoverRuleSnapshot();
  return rules.map((rule) => ({ ...rule }));
}

export async function saveGatewayFailoverRule(input: GatewayFailoverRuleInput) {
  const normalized = normalizeRuleInput(input);
  await ensureGatewayFailoverRuleSchema();
  const now = new Date().toISOString();
  let saved: GatewayFailoverRule | undefined;
  await updateAppDatabase((db) => {
    const existing = normalized.id
      ? db.prepare("SELECT * FROM gateway_failover_rules WHERE id = ?").get(normalized.id) as RuleRow | undefined
      : undefined;
    const count = Number((db.prepare("SELECT COUNT(*) AS count FROM gateway_failover_rules").get() as { count?: number } | undefined)?.count || 0);
    if (!existing && count >= GATEWAY_FAILOVER_RULE_LIMITS.maxRuleCount) {
      throw new Error(`Gateway 故障规则最多保存 ${GATEWAY_FAILOVER_RULE_LIMITS.maxRuleCount} 条。`);
    }
    saved = {
      id: existing?.id || crypto.randomUUID(),
      scope: normalized.scope,
      ...(normalized.providerId ? { providerId: normalized.providerId } : {}),
      ...(normalized.vendorId ? { vendorId: normalized.vendorId } : {}),
      pattern: normalized.pattern,
      ...(normalized.statusCodes.length ? { statusCodes: normalized.statusCodes } : {}),
      ...(normalized.customResponseStatus !== undefined ? { customResponseStatus: normalized.customResponseStatus } : {}),
      ...(normalized.customResponseBody !== undefined ? { customResponseBody: normalized.customResponseBody } : {}),
      enabled: normalized.enabled,
      createdAt: existing?.created_at || now,
      updatedAt: now
    };
    db.prepare(`
      INSERT INTO gateway_failover_rules
        (id, scope, provider_id, vendor_id, pattern, status_codes, custom_response_status, custom_response_body, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        provider_id = excluded.provider_id,
        vendor_id = excluded.vendor_id,
        pattern = excluded.pattern,
        status_codes = excluded.status_codes,
        custom_response_status = excluded.custom_response_status,
        custom_response_body = excluded.custom_response_body,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      saved.id,
      saved.scope,
      saved.providerId || null,
      saved.vendorId || null,
      saved.pattern,
      JSON.stringify(normalized.statusCodes),
      saved.customResponseStatus ?? null,
      saved.customResponseBody ?? null,
      saved.enabled ? 1 : 0,
      saved.createdAt,
      saved.updatedAt
    );
  });
  invalidateGatewayFailoverRuleSnapshot();
  return saved!;
}

export async function deleteGatewayFailoverRule(ruleId: string) {
  const id = ruleId.trim();
  if (!id) throw new Error("规则 ID 不能为空。");
  await ensureGatewayFailoverRuleSchema();
  await updateAppDatabase((db) => {
    db.prepare("DELETE FROM gateway_failover_rules WHERE id = ?").run(id);
  });
  invalidateGatewayFailoverRuleSnapshot();
  return { deleted: true };
}

export async function setGatewayFailoverRuleEnabled(ruleId: string, enabled: boolean) {
  const id = ruleId.trim();
  if (!id) throw new Error("规则 ID 不能为空。");
  await ensureGatewayFailoverRuleSchema();
  let found = false;
  await updateAppDatabase((db) => {
    const result = db.prepare("UPDATE gateway_failover_rules SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    found = result.changes > 0;
  });
  if (!found) throw new Error("Gateway 故障规则不存在。");
  invalidateGatewayFailoverRuleSnapshot();
  return { ruleId: id, enabled };
}

export async function getEffectiveGatewayFailoverRules(providerId: AiProviderId, vendorId?: string) {
  const custom = await getGatewayFailoverRuleSnapshot();
  return [
    ...GATEWAY_FAILOVER_DEFAULT_PATTERNS.map((pattern) => ({ pattern })),
    ...GATEWAY_FAILOVER_DEFAULT_STATUS_CODES.map((statusCode) => ({ statusCodes: [statusCode] })),
    ...custom
      .filter((rule) => rule.enabled && isRuleInScope(rule, providerId, vendorId))
      .map((rule) => ({ pattern: rule.pattern, statusCodes: rule.statusCodes }))
  ];
}

export async function matchesGatewayFailoverError(message: string | undefined, providerId: AiProviderId, vendorId?: string, statusCode?: number) {
  const rules = await getEffectiveGatewayFailoverRules(providerId, vendorId);
  return rules.some((rule) => matchesGatewayFailoverCondition(rule, statusCode, message));
}

export async function getGatewayFailoverCustomResponse(message: string | undefined, providerId: AiProviderId, vendorId?: string, statusCode?: number) {
  const rules = await getGatewayFailoverRuleSnapshot();
  return rules.find((rule) => rule.enabled
    && isRuleInScope(rule, providerId, vendorId)
    && matchesGatewayFailoverCondition(rule, statusCode, message)
    && rule.customResponseStatus !== undefined
    && rule.customResponseBody !== undefined);
}

export function invalidateGatewayFailoverRuleSnapshot() {
  snapshotVersion += 1;
  snapshot = null;
}

async function getGatewayFailoverRuleSnapshot() {
  if (snapshot) return snapshot;
  if (!loading || loadingVersion !== snapshotVersion) {
    const version = snapshotVersion;
    const request = ensureGatewayFailoverRuleSchema().then(() => readAppDatabase((db) => {
      const rows = db.prepare("SELECT * FROM gateway_failover_rules ORDER BY created_at ASC, id ASC").all() as RuleRow[];
      return rows.map(rowToRule);
    })).catch(() => []);
    const current = request.then((rules) => {
      if (version === snapshotVersion) snapshot = rules;
      return rules;
    }).finally(() => {
      if (loading === current) loading = null;
    });
    loading = current;
    loadingVersion = version;
  }
  return loading;
}

function rowToRule(row: RuleRow): GatewayFailoverRule {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.vendor_id ? { vendorId: row.vendor_id } : {}),
    pattern: row.pattern,
    ...(parseStatusCodes(row.status_codes).length ? { statusCodes: parseStatusCodes(row.status_codes) } : {}),
    ...(row.custom_response_status !== null && row.custom_response_status !== undefined ? { customResponseStatus: row.custom_response_status } : {}),
    ...(row.custom_response_body !== null && row.custom_response_body !== undefined ? { customResponseBody: row.custom_response_body } : {}),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeRuleInput(input: GatewayFailoverRuleInput) {
  const scope = input.scope;
  if (scope !== "global" && scope !== "provider" && scope !== "vendor") throw new Error("Gateway 故障规则作用域无效。");
  const pattern = (input.pattern || "").trim().replace(/[\r\n\t]+/g, " ");
  const statusCodes = [...new Set(input.statusCodes || [])].sort((left, right) => left - right);
  if (!pattern && statusCodes.length === 0) throw new Error("请至少配置错误文本或 HTTP 状态码。");
  if (pattern.length > GATEWAY_FAILOVER_RULE_LIMITS.maxPatternLength) {
    throw new Error(`Gateway 故障规则不能超过 ${GATEWAY_FAILOVER_RULE_LIMITS.maxPatternLength} 个字符。`);
  }
  if (statusCodes.some((statusCode) => !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)) {
    throw new Error("HTTP 状态码必须是 400 到 599 之间的整数。");
  }
  const customResponseStatus = input.customResponseStatus;
  const customResponseBody = input.customResponseBody;
  const hasCustomStatus = customResponseStatus !== undefined;
  const hasCustomBody = typeof customResponseBody === "string" && customResponseBody.trim().length > 0;
  if (hasCustomStatus !== hasCustomBody) throw new Error("自定义返回状态码和内容必须同时配置。");
  if (hasCustomStatus && (!Number.isInteger(customResponseStatus) || customResponseStatus! < 100 || customResponseStatus! > 599)) {
    throw new Error("自定义返回状态码必须是 100 到 599 之间的整数。");
  }
  if (hasCustomBody) {
    if (Buffer.byteLength(customResponseBody!, "utf8") > GATEWAY_FAILOVER_RULE_LIMITS.maxCustomResponseBodyBytes) {
      throw new Error(`自定义返回内容不能超过 ${GATEWAY_FAILOVER_RULE_LIMITS.maxCustomResponseBodyBytes / 1024} KB。`);
    }
    try {
      JSON.parse(customResponseBody!);
    } catch {
      throw new Error("自定义返回内容必须是合法 JSON。");
    }
  }
  const providerId = input.providerId;
  if (scope !== "global" && !providerId) throw new Error("Provider 级和供应商级规则必须指定 Provider。");
  if (scope === "vendor" && !input.vendorId?.trim()) throw new Error("供应商级规则必须指定供应商。");
  if (scope === "global" && (providerId || input.vendorId)) throw new Error("全局规则不能指定 Provider 或供应商。");
  if (scope === "provider" && input.vendorId) throw new Error("Provider 级规则不能指定供应商。");
  return {
    id: input.id?.trim() || undefined,
    scope,
    providerId,
    vendorId: input.vendorId?.trim() || undefined,
    pattern,
    statusCodes,
    customResponseStatus: hasCustomStatus ? customResponseStatus : undefined,
    customResponseBody: hasCustomBody ? customResponseBody : undefined,
    enabled: input.enabled !== false
  };
}

function parseStatusCodes(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((statusCode): statusCode is number => typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599)
      : [];
  } catch {
    return [];
  }
}

function isRuleInScope(rule: GatewayFailoverRule, providerId: AiProviderId, vendorId?: string) {
  if (rule.scope === "global") return true;
  if (rule.scope === "provider") return rule.providerId === providerId;
  return rule.providerId === providerId && Boolean(vendorId) && rule.vendorId === vendorId;
}
