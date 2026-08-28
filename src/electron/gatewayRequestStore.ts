import type { AiProviderId, GatewayUsage, GatewayUsageSummary } from "./types";
import { readAppDatabase, updateAppDatabase } from "./appDatabase";

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

export async function recordGatewayRequest(entry: GatewayRequestRecord) {
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
  } catch {
    // 统计持久化失败不能影响上游响应；文本 Gateway 日志仍会保留元数据。
  }
}

export async function getGatewayUsageSummary(periodStart: string, periodEnd: string): Promise<GatewayUsageSummary> {
  await ensureSchema();
  return readAppDatabase((db) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS request_count,
        SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS failure_count,
        SUM(switched) AS switched_count
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
      ...usage,
      periodStart,
      periodEnd
    };
  });
}
