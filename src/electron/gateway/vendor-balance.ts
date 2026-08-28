import type {
  ApiVendor,
  VendorBalanceBatchResult,
  VendorBalanceRefreshResult,
  VendorBalanceSnapshot
} from "../types";
import { listApiVendors } from "../vendors/vendor-manager";
import {
  readAppDatabase,
  updateAppDatabase
} from "../core/app-database";

const BALANCE_TIMEOUT_MS = 10_000;
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
  const genericPaths = ["/user/balance", "/v1/usage"];
  let genericError: Error | undefined;
  for (const requestPath of genericPaths) {
    try {
      for (const endpoint of buildEndpointCandidates(baseUrl, requestPath)) {
        try {
          const body = await requestJson(endpoint, vendor);
          const parsed = parseGenericBalance(body);
          if (parsed) return parsed;
          genericError = new Error("余额接口返回中未找到可识别的余额字段。");
        } catch (error: unknown) {
          genericError = error instanceof Error ? error : new Error(String(error));
          if (!isFallbackStatusError(error)) throw error;
        }
      }
    } catch (error: unknown) {
      genericError = error instanceof Error ? error : new Error(String(error));
      if (!isFallbackStatusError(error)) break;
    }
  }

  // New API 常见于 OpenAI 兼容中转站；仅在通用接口不可用时尝试，避免无意义的额外请求。
  try {
    for (const endpoint of buildEndpointCandidates(baseUrl, "/api/user/self")) {
      try {
        const body = await requestJson(endpoint, vendor);
        const parsed = parseNewApiBalance(body);
        if (parsed) return parsed;
      } catch (error: unknown) {
        if (!isFallbackStatusError(error)) throw error;
      }
    }
  } catch (error: unknown) {
    throw genericError || (error instanceof Error ? error : new Error(String(error)));
  }
  throw genericError || new Error("余额接口返回格式无法识别。");
}

async function requestJson(url: string, vendor: ApiVendor): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (vendor.apiKey) {
      headers.authorization = `Bearer ${vendor.apiKey}`;
      if (vendor.providerId === "claude") headers["x-api-key"] = vendor.apiKey;
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
  const remaining = firstNumber(root, ["remaining", "balance", "available", "quota.remaining", "data.remaining", "data.balance", "credits.balance"]);
  if (remaining === undefined) return null;
  const total = firstNumber(root, ["total", "quota.total", "data.total", "credits.total"]);
  const used = firstNumber(root, ["used", "quota.used", "data.used", "credits.used"]);
  return {
    remaining,
    total,
    used,
    unit: firstString(root, ["unit", "quota.unit", "data.unit"]) || undefined,
    planName: firstString(root, ["plan", "plan_name", "data.plan", "data.plan_name"]) || undefined,
    isValid: true
  };
}

export function parseNewApiBalance(body: unknown): VendorBalanceSnapshot | null {
  const root = isRecord(body) ? body : {};
  const quota = firstNumber(root, ["data.quota", "quota"]);
  const usedQuota = firstNumber(root, ["data.used_quota", "used_quota"]);
  if (quota === undefined) return null;
  const total = quota / NEW_API_QUOTA_UNIT;
  const used = (usedQuota || 0) / NEW_API_QUOTA_UNIT;
  return {
    total,
    used,
    remaining: Math.max(0, total - used),
    unit: "额度",
    planName: firstString(root, ["data.group", "data.plan", "group", "plan"]) || undefined,
    isValid: true
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

function readPath(root: JsonRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFallbackStatusError(error: unknown) {
  return (error instanceof BalanceHttpError && [404, 405, 501].includes(error.status))
    || error instanceof BalanceResponseError;
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
