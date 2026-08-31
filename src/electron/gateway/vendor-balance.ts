import type {
  ApiVendor,
  VendorBalanceBatchResult,
  VendorBalanceRefreshResult,
  VendorBalanceSnapshot,
  VendorBalanceQueryConfig
} from "../types";
import { listApiVendors } from "../vendors/vendor-manager";
import {
  readAppDatabase,
  updateAppDatabase
} from "../core/app-database";

const BALANCE_TIMEOUT_MS = 15_000;
const BALANCE_BATCH_CONCURRENCY = 3;
const NEW_API_QUOTA_UNIT = 500_000;

type BalanceRow = {
  vendor_id: string;
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string | null;
  plan_name: string | null;
  is_valid: number;
  status: "idle" | "loading" | "success" | "error";
  error_message: string | null;
  queried_at: string | null;
};

type JsonRecord = Record<string, unknown>;

let schemaPromise: Promise<void> | null = null;

/**
 * 余额结果使用独立表保存，避免把历史查询状态和供应商的密钥配置混在一起。
 * 旧版本数据库会在首次调用余额功能时自动创建该表。
 */
async function ensureBalanceSchema() {
  if (!schemaPromise) {
    schemaPromise = updateAppDatabase((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_vendor_balance_snapshots (
          vendor_id TEXT PRIMARY KEY,
          remaining REAL,
          total REAL,
          used REAL,
          unit TEXT,
          plan_name TEXT,
          is_valid INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'idle',
          error_message TEXT,
          queried_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vendor_balance_queried_at
          ON api_vendor_balance_snapshots(queried_at);
      `);
    }).finally(() => {
      schemaPromise = null;
    });
  }
  await schemaPromise;
}

export async function listVendorBalanceSnapshots(): Promise<Record<string, VendorBalanceRefreshResult["balance"] & {
  status: BalanceRow["status"];
  error?: string;
  queriedAt?: string;
}>> {
  await ensureBalanceSchema();
  return readAppDatabase((db) => {
    const rows = db.prepare("SELECT * FROM api_vendor_balance_snapshots").all() as BalanceRow[];
    return Object.fromEntries(rows.map((row) => [row.vendor_id, rowToBalanceState(row)]));
  });
}

export async function refreshVendorBalance(vendorId: string): Promise<VendorBalanceRefreshResult> {
  const startedAt = Date.now();
  const queriedAt = new Date().toISOString();
  await ensureBalanceSchema();
  const vendor = (await listApiVendors()).find((item) => item.id === vendorId);
  if (!vendor) {
    return {
      vendorId,
      ok: false,
      message: "供应商不存在。",
      queriedAt,
      latencyMs: Date.now() - startedAt
    };
  }

  return refreshLoadedVendorBalance(vendor, startedAt, queriedAt);
}

async function refreshLoadedVendorBalance(vendor: ApiVendor, startedAt = Date.now(), queriedAt = new Date().toISOString()): Promise<VendorBalanceRefreshResult> {
  try {
    const balance = await queryVendorBalance(vendor);
    await saveBalanceSnapshot(vendor.id, {
      ...balance,
      status: "success",
      error: undefined,
      queriedAt
    });
    return { vendorId: vendor.id, ok: true, balance, queriedAt, latencyMs: Date.now() - startedAt };
  } catch (error: unknown) {
    const message = normalizeBalanceError(error);
    // 查询失败不删除上一次成功的金额，列表仍可显示旧值并标记为过期。
    await saveBalanceSnapshot(vendor.id, {
      status: "error",
      error: message,
      queriedAt
    });
    return { vendorId: vendor.id, ok: false, message, queriedAt, latencyMs: Date.now() - startedAt };
  }
}

export async function refreshVendorBalances(): Promise<VendorBalanceBatchResult> {
  const vendors = await listApiVendors();
  const items: Array<VendorBalanceRefreshResult | undefined> = Array.from({ length: vendors.length });
  let cursor = 0;

  // 有限并发可以避免供应商数量较多时同时触发第三方限流。
  async function worker() {
    while (cursor < vendors.length) {
      const index = cursor++;
      const vendor = vendors[index];
      items[index] = await refreshLoadedVendorBalance(vendor);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BALANCE_BATCH_CONCURRENCY, vendors.length) }, () => worker()));
  const completedItems = items.filter((item): item is VendorBalanceRefreshResult => Boolean(item));
  return {
    items: completedItems,
    succeeded: completedItems.filter((item) => item.ok).length,
    failed: completedItems.filter((item) => !item.ok).length
  };
}

async function queryVendorBalance(vendor: ApiVendor): Promise<VendorBalanceSnapshot> {
  if (!vendor.apiBaseUrl) throw new Error("供应商未配置 API 地址。");
  let baseUrl: URL;
  try {
    baseUrl = new URL(vendor.apiBaseUrl);
  } catch {
    throw new Error("供应商 API 地址格式无效。");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("供应商 API 地址必须使用 HTTP 或 HTTPS。");
  }
  const configured = vendor.balanceQuery;
  if (configured && configured.template && configured.template !== "auto") {
    if (configured.template === "custom") return queryConfiguredBalance(vendor, configured);
    if (configured.template === "generic" && !configured.endpoint) {
      let lastError: unknown;
      for (const endpoint of ["/user/balance", "/v1/usage"]) {
        try {
          return await queryConfiguredBalance(vendor, { ...configured, endpoint }, parseGenericBalance);
        } catch (error: unknown) {
          lastError = error;
        }
      }
      throw (lastError instanceof Error ? lastError : new Error("余额接口返回格式无法识别。"));
    }
    const path = configured.template === "new-api" ? "/api/user/self" : "/user/balance";
    const parser = configured.template === "new-api" ? parseNewApiBalance : parseGenericBalance;
    return queryConfiguredBalance(vendor, { ...configured, endpoint: configured.endpoint || path }, parser);
  }
  const attempts: Array<{ path: string; parser: (body: unknown) => VendorBalanceSnapshot | null }> = [
    { path: "/user/balance", parser: parseGenericBalance },
    { path: "/v1/usage", parser: parseGenericBalance },
    { path: "/api/user/self", parser: parseNewApiBalance }
  ];
  let lastError: Error | undefined;
  for (const attempt of attempts) {
    for (const endpoint of buildEndpointCandidates(baseUrl, attempt.path)) {
      try {
        const body = await requestJson(endpoint, vendor);
        const parsed = attempt.parser(body);
        if (parsed) return parsed;
        lastError = new Error("余额接口返回中未找到可识别的余额字段。");
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // 余额接口通常是供应商私有能力；认证失败、路径不存在和非 JSON 响应都继续探测，
        // 避免通用接口拒绝后阻断 New API 或其他候选路径。
        continue;
      }
    }
  }
  throw lastError || new Error("余额接口返回格式无法识别。");
}

async function queryConfiguredBalance(
  vendor: ApiVendor,
  config: VendorBalanceQueryConfig,
  parser?: (body: unknown) => VendorBalanceSnapshot | null
) {
  const base = config.baseUrl || vendor.apiBaseUrl;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new Error("余额查询地址格式无效。");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new Error("余额查询地址必须使用 HTTP 或 HTTPS。");
  const endpoint = config.endpoint || "/user/balance";
  const url = new URL(endpoint, baseUrl).toString();
  const body = await requestConfiguredJson(url, vendor, config);
  const result = parser ? parser(body) : parseCustomBalance(body, config);
  if (!result) {
    const message = config.invalidMessagePath ? readJsonString(body, config.invalidMessagePath) : undefined;
    throw new Error(message || "自定义余额响应中未找到可识别的余额字段。");
  }
  return applyBalanceMultiplier(result, config.multiplier);
}

async function requestConfiguredJson(url: string, vendor: ApiVendor, config: VendorBalanceQueryConfig): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const authMode = config.authMode || defaultBalanceAuthMode(vendor.providerId);
    const token = config.accessToken || vendor.apiKey;
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.headers) Object.assign(headers, config.headers);
    if (authMode === "bearer") headers[config.authHeaderName || "authorization"] = `Bearer ${token}`;
    else if (authMode === "x-api-key") headers[config.authHeaderName || "x-api-key"] = token;
    else if (authMode === "x-goog-api-key") headers[config.authHeaderName || "x-goog-api-key"] = token;
    else if (authMode === "api-key") headers[config.authHeaderName || "api-key"] = token;
    let requestUrl = url;
    if (authMode === "query" && token) {
      const parsed = new URL(url);
      parsed.searchParams.set(config.authQueryName || "key", token);
      requestUrl = parsed.toString();
    }
    if (config.userId) headers["New-Api-User"] = config.userId;
    if (config.method === "POST") headers["content-type"] = "application/json";
    const response = await fetch(requestUrl, {
      method: config.method || "GET",
      headers,
      ...(config.method === "POST" ? { body: "{}" } : {}),
      signal: controller.signal
    });
    if (!response.ok) throw new BalanceHttpError(response.status);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("余额接口响应过大。");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BalanceResponseError("余额接口返回的不是有效 JSON。");
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("余额查询超时。", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultBalanceAuthMode(providerId: ApiVendor["providerId"]): "bearer" | "x-api-key" | "x-goog-api-key" {
  if (providerId === "gemini") return "x-goog-api-key";
  if (providerId === "claude") return "x-api-key";
  return "bearer";
}

function parseCustomBalance(body: unknown, config: VendorBalanceQueryConfig): VendorBalanceSnapshot | null {
  if (!isRecord(body)) return null;
  const remaining = readJsonNumber(body, config.remainingPath || "remaining");
  if (remaining === undefined) return null;
  const total = config.totalPath ? readJsonNumber(body, config.totalPath) : undefined;
  const used = config.usedPath ? readJsonNumber(body, config.usedPath) : undefined;
  const valid = config.validPath ? readJsonBoolean(body, config.validPath) : true;
  const status = config.statusPath ? readJsonString(body, config.statusPath)?.toLowerCase() : undefined;
  return {
    remaining,
    total,
    used,
    unit: config.unitPath ? readJsonString(body, config.unitPath) : "USD",
    planName: config.planPath ? readJsonString(body, config.planPath) : undefined,
    isValid: valid !== false && !["expired", "disabled", "invalid", "error"].includes(status || "")
  };
}

function applyBalanceMultiplier(snapshot: VendorBalanceSnapshot, multiplier: number | undefined) {
  if (!multiplier || multiplier === 1) return snapshot;
  return {
    ...snapshot,
    remaining: snapshot.remaining === undefined ? undefined : snapshot.remaining * multiplier,
    total: snapshot.total === undefined ? undefined : snapshot.total * multiplier,
    used: snapshot.used === undefined ? undefined : snapshot.used * multiplier
  };
}

async function requestJson(url: string, vendor: ApiVendor): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    // 兼容常见聚合站默认认证约定；供应商只读取其中一种时会忽略其他 Header。
    const headers: Record<string, string> = { accept: "application/json" };
    if (vendor.apiKey) {
      headers.authorization = `Bearer ${vendor.apiKey}`;
      headers["x-api-key"] = vendor.apiKey;
      headers["api-key"] = vendor.apiKey;
      if (vendor.providerId === "gemini") headers["x-goog-api-key"] = vendor.apiKey;
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new BalanceHttpError(response.status);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("余额接口响应过大。");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BalanceResponseError("余额接口返回的不是有效 JSON。");
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("余额查询超时。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseGenericBalance(body: unknown): VendorBalanceSnapshot | null {
  const root = isRecord(body) ? body : {};
  const success = firstBoolean(root, ["success", "data.success"]);
  const active = firstBoolean(root, ["is_active", "active", "data.is_active", "data.active", "isValid", "is_valid", "data.isValid", "data.is_valid"]);
  const status = firstString(root, ["status", "data.status"]);
  const remaining = firstNumber(root, ["remaining", "balance", "available", "quota.remaining", "data.remaining", "data.balance", "data.available", "data.quota.remaining", "credits.balance"]);
  if (remaining === undefined) return null;
  const total = firstNumber(root, ["total", "quota.total", "data.total", "data.quota.total", "credits.total"]);
  const used = firstNumber(root, ["used", "quota.used", "data.used", "data.quota.used", "credits.used"]);
  return {
    remaining,
    total,
    used,
    unit: firstString(root, ["unit", "currency", "quota.unit", "data.unit", "data.currency"]) || "USD",
    planName: firstString(root, ["plan", "plan_name", "data.plan", "data.plan_name"]) || undefined,
    isValid: success !== false && active !== false && !["expired", "quota_exhausted", "disabled"].includes((status || "").toLowerCase())
  };
}

export function parseNewApiBalance(body: unknown): VendorBalanceSnapshot | null {
  const root = isRecord(body) ? body : {};
  const success = firstBoolean(root, ["success", "data.success"]);
  const quota = firstNumber(root, ["data.quota", "quota"]);
  const usedQuota = firstNumber(root, ["data.used_quota", "used_quota"]);
  if (quota === undefined) return null;
  // New API 的 quota 表示剩余额度，不能直接当成总额度。
  const remaining = quota / NEW_API_QUOTA_UNIT;
  const used = (usedQuota || 0) / NEW_API_QUOTA_UNIT;
  return {
    total: remaining + used,
    used,
    remaining,
    unit: "额度",
    planName: firstString(root, ["data.group", "data.plan", "group", "plan"]) || undefined,
    isValid: success !== false
  };
}

function buildEndpointCandidates(baseUrl: URL, suffix: string) {
  const prefix = baseUrl.pathname.replace(/\/+$/, "");
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  const paths = new Set<string>();
  if (prefix) {
    paths.add(prefix.endsWith("/v1") && suffix === "/v1/usage"
      ? `${prefix}/usage`
      : `${prefix}/${normalizedSuffix}`);
  }
  paths.add(`/${normalizedSuffix}`);
  return [...paths].map((path) => new URL(path, baseUrl.origin).toString());
}

function firstNumber(root: JsonRecord, paths: string[]) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function firstString(root: JsonRecord, paths: string[]) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstBoolean(root: JsonRecord, paths: string[]) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "active", "ok"].includes(normalized)) return true;
      if (["false", "0", "no", "inactive", "disabled"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function readPath(root: JsonRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root);
}

function readJsonNumber(root: unknown, path: string) {
  const value = isRecord(root) ? readPath(root, path) : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function readJsonString(root: unknown, path: string) {
  const value = isRecord(root) ? readPath(root, path) : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readJsonBoolean(root: unknown, path: string) {
  const value = isRecord(root) ? readPath(root, path) : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "ok", "active"].includes(normalized)) return true;
    if (["false", "0", "no", "disabled", "inactive"].includes(normalized)) return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class BalanceHttpError extends Error {
  constructor(public readonly status: number) {
    super(`余额接口请求失败 (${status})`);
  }
}

class BalanceResponseError extends Error {}

function normalizeBalanceError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "余额查询失败。";
}

async function saveBalanceSnapshot(
  vendorId: string,
  state: { remaining?: number; total?: number; used?: number; unit?: string; planName?: string; isValid?: boolean; status: BalanceRow["status"]; error?: string; queriedAt: string }
) {
  await updateAppDatabase((db) => {
    const existing = db.prepare("SELECT * FROM api_vendor_balance_snapshots WHERE vendor_id = ?").get(vendorId) as BalanceRow | undefined;
    db.prepare(`
      INSERT INTO api_vendor_balance_snapshots
        (vendor_id, remaining, total, used, unit, plan_name, is_valid, status, error_message, queried_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vendor_id) DO UPDATE SET
        remaining = excluded.remaining,
        total = excluded.total,
        used = excluded.used,
        unit = excluded.unit,
        plan_name = excluded.plan_name,
        is_valid = excluded.is_valid,
        status = excluded.status,
        error_message = excluded.error_message,
        queried_at = excluded.queried_at
    `).run(
      vendorId,
      state.status === "error" ? state.remaining ?? existing?.remaining ?? null : state.remaining ?? null,
      state.status === "error" ? state.total ?? existing?.total ?? null : state.total ?? null,
      state.status === "error" ? state.used ?? existing?.used ?? null : state.used ?? null,
      state.status === "error" ? state.unit ?? existing?.unit ?? null : state.unit ?? null,
      state.status === "error" ? state.planName ?? existing?.plan_name ?? null : state.planName ?? null,
      state.isValid === undefined ? existing?.is_valid ?? 1 : state.isValid ? 1 : 0,
      state.status,
      state.error || null,
      state.queriedAt
    );
  });
}

function rowToBalanceState(row: BalanceRow) {
  return {
    remaining: row.remaining ?? undefined,
    total: row.total ?? undefined,
    used: row.used ?? undefined,
    unit: row.unit || undefined,
    planName: row.plan_name || undefined,
    isValid: row.is_valid === 1,
    status: row.status,
    error: row.error_message || undefined,
    queriedAt: row.queried_at || undefined
  };
}
