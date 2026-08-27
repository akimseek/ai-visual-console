import fs from "node:fs/promises";
import path from "node:path";

// 本地 Gateway 的结构化日志：环形缓冲 + 防抖批量落盘。
// 仅记录请求元数据（路由、供应商、状态码、耗时、失败原因），绝不记录请求/响应正文或 API Key。
// 用于生产排障：切换是否生效、上游错误、客户端中断、耗时异常等。

export type GatewayRequestLog = {
  ts: string;
  routeId: string;
  provider: string;
  vendorId: string;
  vendorName?: string;
  method: string;
  path: string;
  upstreamStatus?: number;
  durationMs: number;
  bytesIn?: number;
  bytesOut?: number;
  outcome: "ok" | "client-aborted" | "timeout" | "error";
  errorCode?: string;
  error?: string;
};

export type GatewayEventLog = {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  detail?: Record<string, unknown>;
};

const RING_CAPACITY = 200;
const EVENT_RING_CAPACITY = 100;
const FLUSH_INTERVAL_MS = 200;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const requestRing: GatewayRequestLog[] = [];
const eventRing: GatewayEventLog[] = [];
let logDirectory = "";
let pendingRequests: GatewayRequestLog[] = [];
let pendingEvents: GatewayEventLog[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

export function setGatewayLogPath(dir: string) {
  logDirectory = dir;
}

export function recordGatewayRequest(entry: Omit<GatewayRequestLog, "ts">) {
  const full: GatewayRequestLog = { ...entry, ts: new Date().toISOString() };
  requestRing.push(full);
  if (requestRing.length > RING_CAPACITY) requestRing.shift();
  pendingRequests.push(full);
  scheduleFlush();
}

export function logGatewayEvent(
  level: GatewayEventLog["level"],
  event: string,
  detail?: Record<string, unknown>
) {
  const full: GatewayEventLog = { ts: new Date().toISOString(), level, event, detail };
  eventRing.push(full);
  if (eventRing.length > EVENT_RING_CAPACITY) eventRing.shift();
  pendingEvents.push(full);
  scheduleFlush();
}

export function getRecentGatewayRequests(limit = 50): GatewayRequestLog[] {
  return requestRing.slice(-limit);
}

export function getRecentGatewayEvents(limit = 50): GatewayEventLog[] {
  return eventRing.slice(-limit);
}

function scheduleFlush() {
  if (flushTimer || !logDirectory) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushToFile();
  }, FLUSH_INTERVAL_MS);
}

async function flushToFile() {
  if (flushing || pendingRequests.length === 0 && pendingEvents.length === 0) return;
  flushing = true;
  const requests = pendingRequests;
  const events = pendingEvents;
  pendingRequests = [];
  pendingEvents = [];
  try {
    await fs.mkdir(logDirectory, { recursive: true });
    const filePath = path.join(logDirectory, "gateway.log");
    const lines = [
      ...events.map((event) => JSON.stringify(event)),
      ...requests.map((request) => JSON.stringify(request))
    ];
    const payload = `${lines.join("\n")}\n`;
    const currentSize = await fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
    if (currentSize > 0 && currentSize + Buffer.byteLength(payload, "utf8") > MAX_LOG_BYTES) {
      const rotatedPath = `${filePath}.1`;
      await fs.rm(rotatedPath, { force: true });
      await fs.rename(filePath, rotatedPath);
    }
    await fs.appendFile(filePath, payload, "utf8");
  } catch {
    // 日志落盘失败不应影响网关转发；记录已在内存环形缓冲中，仍可供诊断导出。
  } finally {
    flushing = false;
  }
}

// 测试与诊断导出时，确保已缓冲的日志写入磁盘后再读取。
export async function flushGatewayLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushToFile();
}
