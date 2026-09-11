import crypto from "node:crypto";
import type {
  AiProviderId,
  GatewayFailoverRule,
  GatewayFailoverRuleInput,
  GatewayFailoverRuleScope
} from "../../shared/types";
import { GATEWAY_FAILOVER_DEFAULT_PATTERNS, GATEWAY_FAILOVER_RULE_LIMITS } from "../../shared/constants";
import { readAppDatabase, updateAppDatabase, type SqliteDatabase } from "../core/app-database";

type RuleRow = {
  id: string;
  scope: GatewayFailoverRuleScope;
  provider_id: AiProviderId | null;
  vendor_id: string | null;
  pattern: string;
  enabled: number;
  priority: number;
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
      pattern TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_failover_rules_scope
      ON gateway_failover_rules(scope, provider_id, vendor_id, enabled, priority);
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
      enabled: normalized.enabled,
      priority: normalized.priority,
      createdAt: existing?.created_at || now,
      updatedAt: now
    };
    db.prepare(`
      INSERT INTO gateway_failover_rules
        (id, scope, provider_id, vendor_id, pattern, enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        provider_id = excluded.provider_id,
        vendor_id = excluded.vendor_id,
        pattern = excluded.pattern,
        enabled = excluded.enabled,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `).run(
      saved.id,
      saved.scope,
      saved.providerId || null,
      saved.vendorId || null,
      saved.pattern,
      saved.enabled ? 1 : 0,
      saved.priority,
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
    ...GATEWAY_FAILOVER_DEFAULT_PATTERNS.map((pattern, index) => ({ pattern, priority: index })),
    ...custom
      .filter((rule) => rule.enabled && isRuleInScope(rule, providerId, vendorId))
      .map((rule) => ({ pattern: rule.pattern, priority: rule.priority }))
  ].sort((left, right) => left.priority - right.priority);
}

export async function matchesGatewayFailoverError(message: string | undefined, providerId: AiProviderId, vendorId?: string) {
  if (!message?.trim()) return false;
  const normalized = message.toLocaleLowerCase();
  const rules = await getEffectiveGatewayFailoverRules(providerId, vendorId);
  return rules.some((rule) => normalized.includes(rule.pattern.toLocaleLowerCase()));
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
      const rows = db.prepare("SELECT * FROM gateway_failover_rules ORDER BY priority ASC, updated_at ASC").all() as RuleRow[];
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
    enabled: row.enabled === 1,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeRuleInput(input: GatewayFailoverRuleInput) {
  const scope = input.scope;
  if (scope !== "global" && scope !== "provider" && scope !== "vendor") throw new Error("Gateway 故障规则作用域无效。");
  const pattern = input.pattern.trim().replace(/[\r\n\t]+/g, " ");
  if (!pattern) throw new Error("Gateway 故障规则不能为空。");
  if (pattern.length > GATEWAY_FAILOVER_RULE_LIMITS.maxPatternLength) {
    throw new Error(`Gateway 故障规则不能超过 ${GATEWAY_FAILOVER_RULE_LIMITS.maxPatternLength} 个字符。`);
  }
  const providerId = input.providerId;
  if (scope !== "global" && !providerId) throw new Error("Provider 级和供应商级规则必须指定 Provider。");
  if (scope === "vendor" && !input.vendorId?.trim()) throw new Error("供应商级规则必须指定供应商。");
  if (scope === "global" && (providerId || input.vendorId)) throw new Error("全局规则不能指定 Provider 或供应商。");
  if (scope === "provider" && input.vendorId) throw new Error("Provider 级规则不能指定供应商。");
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > GATEWAY_FAILOVER_RULE_LIMITS.maxPriority) {
    throw new Error(`规则优先级必须是 0 到 ${GATEWAY_FAILOVER_RULE_LIMITS.maxPriority} 之间的整数。`);
  }
  return {
    id: input.id?.trim() || undefined,
    scope,
    providerId,
    vendorId: input.vendorId?.trim() || undefined,
    pattern,
    enabled: input.enabled !== false,
    priority
  };
}

function isRuleInScope(rule: GatewayFailoverRule, providerId: AiProviderId, vendorId?: string) {
  if (rule.scope === "global") return true;
  if (rule.scope === "provider") return rule.providerId === providerId;
  return rule.providerId === providerId && Boolean(vendorId) && rule.vendorId === vendorId;
}
