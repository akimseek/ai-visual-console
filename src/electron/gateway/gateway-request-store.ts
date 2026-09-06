import type { AiProviderId, GatewayFailureDiagnostic, GatewayFailureDiagnosticsPage, GatewayFailureOutcomeFilter, GatewayLogCleanupEntry, GatewayLogCleanupFilter, GatewayRecentFailure, GatewayUsage, GatewayUsageReport, GatewayUsageSummary } from "../types";
import { readAppDatabase, updateAppDatabase } from "../core/app-database";
import { aggregateGatewayUsage } from "./gateway-usage";
import { PAGINATION_DEFAULT_PAGE_SIZE, PAGINATION_MAX_PAGE_SIZE } from "../../shared/constants";

export type GatewayRequestRecord = {
  requestId: string;
  routeId: string;
  providerId: AiProviderId;
  vendorId: string;
  method: string;
  path: string;
  model?: string;
  upstreamStatus?: number;
  outcome: "ok" | "client-aborted" | "timeout" | "error";
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
  retryCount: number;
  switched: boolean;
  errorCode?: string;
  errorMessage?: string;
  usage?: GatewayUsage;
  createdAt: string;
};

let schemaPromise: Promise<void> | null = null;

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = updateAppDatabase((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_request_logs (
        request_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        vendor_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        upstream_status INTEGER,
        outcome TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        switched INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_created_at
        ON gateway_request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gateway_request_logs_vendor
        ON gateway_request_logs(vendor_id, created_at DESC);
    `)).finally(() => { schemaPromise = null; });
  }
  await schemaPromise;
}

export async function recordGatewayRequest(entry: GatewayRequestRecord): Promise<boolean> {
  try {
    await ensureSchema();
    await updateAppDatabase((db) => db.prepare(`
      INSERT OR REPLACE INTO gateway_request_logs
        (request_id, route_id, provider_id, vendor_id, method, path, model, upstream_status, outcome, duration_ms, bytes_in, bytes_out, retry_count, switched, error_code, error_message, usage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.requestId,
      entry.routeId,
      entry.providerId,
      entry.vendorId,
      entry.method,
      entry.path.slice(0, 500),
      entry.model || null,
      entry.upstreamStatus || null,
      entry.outcome,
      entry.durationMs,
      entry.bytesIn,
      entry.bytesOut,
      entry.retryCount,
      entry.switched ? 1 : 0,
      entry.errorCode || null,
      entry.errorMessage?.slice(0, 500) || null,
      entry.usage ? JSON.stringify(entry.usage) : null,
      entry.createdAt
    ));
    return true;
  } catch {
    // 统计持久化失败不能影响上游响应；文本 Gateway 日志仍会保留元数据。
    return false;
  }
}

export async function clearGatewayRequestLogs(filter: Omit<GatewayLogCleanupFilter, "scope"> = {}) {
  await ensureSchema();
  return updateAppDatabase((db) => {
    const filters: string[] = [];
    const params: string[] = [];
    if (filter.vendorId?.trim()) {
      filters.push("vendor_id = ?");
      params.push(filter.vendorId.trim());
    }
    if (filter.outcome) {
      filters.push("outcome = ?");
      params.push(filter.outcome);
    }
    if (filter.periodStart) {
      filters.push("created_at >= ?");
      params.push(filter.periodStart);
    }
    if (filter.periodEnd) {
      filters.push("created_at <= ?");
      params.push(filter.periodEnd);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    return { deleted: db.prepare(`DELETE FROM gateway_request_logs${where}`).run(...params).changes };
  });
}

export async function getGatewayRequestCleanupEntries(filter: Omit<GatewayLogCleanupFilter, "scope"> = {}): Promise<GatewayLogCleanupEntry[]> {
  await ensureSchema();
  return readAppDatabase((db) => {
    const { where, params } = buildCleanupWhere(filter);
    const rows = db.prepare(`
      SELECT request_id, provider_id, vendor_id, method, path, upstream_status,
        outcome, duration_ms, error_code, error_message, created_at
      FROM gateway_request_logs
      WHERE ${where}
      ORDER BY created_at DESC
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.request_id || ""),
      source: "request" as const,
      createdAt: String(row.created_at || ""),
      vendorId: String(row.vendor_id || ""),
      providerId: String(row.provider_id || "") as AiProviderId,
      outcome: toGatewayLogOutcome(row.outcome),
      upstreamStatus: typeof row.upstream_status === "number" ? row.upstream_status : undefined,
      durationMs: typeof row.duration_ms === "number" ? row.duration_ms : undefined,
      errorCode: typeof row.error_code === "string" ? row.error_code : undefined,
      errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
      method: typeof row.method === "string" ? row.method : undefined,
      path: typeof row.path === "string" ? row.path : undefined
    }));
  });
}

export async function deleteGatewayRequestEntries(requestIds: string[]) {
  const ids = [...new Set(requestIds.filter((id) => typeof id === "string" && id.trim()))];
  if (ids.length === 0) return { deleted: 0 };
  await ensureSchema();
  return updateAppDatabase((db) => {
    const placeholders = ids.map(() => "?").join(", ");
    const result = db.prepare(`DELETE FROM gateway_request_logs WHERE request_id IN (${placeholders})`).run(...ids);
    return { deleted: result.changes };
  });
}

function buildCleanupWhere(filter: Omit<GatewayLogCleanupFilter, "scope">) {
  const filters: string[] = [];
  const params: string[] = [];
  if (filter.vendorId?.trim()) {
    filters.push("vendor_id = ?");
    params.push(filter.vendorId.trim());
  }
  if (filter.outcome) {
    filters.push("outcome = ?");
    params.push(filter.outcome);
  }
  if (filter.periodStart) {
    filters.push("created_at >= ?");
    params.push(filter.periodStart);
  }
  if (filter.periodEnd) {
    filters.push("created_at <= ?");
    params.push(filter.periodEnd);
  }
  return { where: filters.length > 0 ? filters.join(" AND ") : "1 = 1", params };
}

function toGatewayLogOutcome(value: unknown) {
  return value === "ok" || value === "client-aborted" || value === "timeout" || value === "error" ? value : undefined;
}

export async function getGatewayUsageSummary(periodStart: string, periodEnd: string): Promise<GatewayUsageSummary> {
  await ensureSchema();
  return readAppDatabase((db) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS request_count,
        SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS failure_count,
        SUM(switched) AS switched_count,
        SUM(retry_count) AS retry_count
      FROM gateway_request_logs WHERE created_at >= ? AND created_at <= ?
    `).get(periodStart, periodEnd) as Record<string, unknown>;
    const usageRows = db.prepare("SELECT usage_json FROM gateway_request_logs WHERE created_at >= ? AND created_at <= ? AND usage_json IS NOT NULL").all(periodStart, periodEnd) as Array<{ usage_json: string }>;
    const usage: GatewayUsage = {};
    for (const item of usageRows) {
      try {
        const parsed = JSON.parse(item.usage_json) as GatewayUsage;
        for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens"] as const) {
          if (typeof parsed[key] === "number") usage[key] = (usage[key] || 0) + parsed[key]!;
        }
        if (typeof parsed.costUsd === "number") usage.costUsd = (usage.costUsd || 0) + parsed.costUsd;
      } catch {
        // 单条 usage 损坏不影响其他请求统计。
      }
    }
    return {
      requestCount: Number(row?.request_count || 0),
      successCount: Number(row?.success_count || 0),
      failureCount: Number(row?.failure_count || 0),
      switchedCount: Number(row?.switched_count || 0),
      retryCount: Number(row?.retry_count || 0),
      ...usage,
      periodStart,
      periodEnd
    };
  });
}

export async function getGatewayUsageReport(periodStart: string, periodEnd: string): Promise<GatewayUsageReport> {
  await ensureSchema();
  return readAppDatabase((db) => {
    const filters: string[] = [];
    const params: string[] = [];
    if (periodStart) {
      filters.push("l.created_at >= ?");
      params.push(periodStart);
    }
    if (periodEnd) {
      filters.push("l.created_at <= ?");
      params.push(periodEnd);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT l.vendor_id, COALESCE(v.name, '已删除供应商') AS vendor_name,
        l.provider_id, l.model, l.outcome, l.duration_ms, l.retry_count, l.switched, l.usage_json
      FROM gateway_request_logs l
      LEFT JOIN api_vendors v ON v.id = l.vendor_id
      ${whereClause}
      ORDER BY l.created_at DESC
    `).all(...params) as Array<Record<string, unknown>>;
    return aggregateGatewayUsage(rows.map((row) => ({
      vendorId: String(row.vendor_id || ""),
      vendorName: String(row.vendor_name || "已删除供应商"),
      providerId: String(row.provider_id || "codex") as AiProviderId,
      model: typeof row.model === "string" ? row.model : undefined,
      outcome: row.outcome === "ok" || row.outcome === "client-aborted" || row.outcome === "timeout" ? row.outcome : "error",
      durationMs: typeof row.duration_ms === "number" ? row.duration_ms : 0,
      retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
      switched: row.switched === 1,
      usageJson: typeof row.usage_json === "string" ? row.usage_json : null
    })), periodStart, periodEnd);
  });
}

// 工作台只需要近期异常的定位线索；固定小窗口避免侧栏查询变成日志全表读取。
export async function getRecentGatewayFailures(): Promise<GatewayRecentFailure[]> {
  return listGatewayFailureDiagnostics(3);
}

// 诊断弹窗按需读取固定数量的异常元数据，只返回截断后的错误代码和受控错误摘要。
export async function getGatewayFailureDiagnostics(): Promise<GatewayFailureDiagnostic[]> {
  return listGatewayFailureDiagnostics(3);
}

export async function getGatewayFailureDiagnosticsPage(page = 1, pageSize = PAGINATION_DEFAULT_PAGE_SIZE, vendorId = "", outcome: GatewayFailureOutcomeFilter = "", periodStart = "", periodEnd = ""): Promise<GatewayFailureDiagnosticsPage> {
  await ensureSchema();
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(PAGINATION_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
  return readAppDatabase((db) => {
    const filters = ["outcome IN ('error', 'timeout')"];
    const filterParams: string[] = [];
    if (vendorId.trim()) {
      filters.push("vendor_id = ?");
      filterParams.push(vendorId.trim());
    }
    if (outcome) {
      filters.push("outcome = ?");
      filterParams.push(outcome);
    }
    if (periodStart) {
      filters.push("created_at >= ?");
      filterParams.push(periodStart);
    }
    if (periodEnd) {
      filters.push("created_at <= ?");
      filterParams.push(periodEnd);
    }
    const whereClause = filters.join(" AND ");
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM gateway_request_logs
      WHERE ${whereClause}
    `).get(...filterParams) as Record<string, unknown>;
    const rows = db.prepare(`
      SELECT vendor_id, provider_id, upstream_status, outcome, retry_count, duration_ms, error_code, error_message, created_at
      FROM gateway_request_logs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...filterParams, safePageSize, (safePage - 1) * safePageSize) as Array<Record<string, unknown>>;
    return {
      items: rows.map(toGatewayFailureDiagnostic),
      total: Number(totalRow?.total || 0),
      page: safePage,
      pageSize: safePageSize
    };
  });
}

async function listGatewayFailureDiagnostics(limit: number): Promise<GatewayFailureDiagnostic[]> {
  await ensureSchema();
  return readAppDatabase((db) => {
    const rows = db.prepare(`
      SELECT vendor_id, provider_id, upstream_status, outcome, retry_count, duration_ms, error_code, error_message, created_at
      FROM gateway_request_logs
      WHERE outcome IN ('error', 'timeout')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(toGatewayFailureDiagnostic);
  });
}

function toGatewayFailureDiagnostic(row: Record<string, unknown>): GatewayFailureDiagnostic {
  return {
    vendorId: String(row.vendor_id || ""),
    providerId: String(row.provider_id || "") as AiProviderId,
    outcome: row.outcome === "timeout" ? "timeout" : "error",
    upstreamStatus: typeof row.upstream_status === "number" ? row.upstream_status : undefined,
    retryCount: typeof row.retry_count === "number" ? row.retry_count : 0,
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : 0,
    errorCode: typeof row.error_code === "string" ? row.error_code : undefined,
    errorMessage: typeof row.error_message === "string" ? row.error_message : undefined,
    createdAt: String(row.created_at || "")
  };
}
