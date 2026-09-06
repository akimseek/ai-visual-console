import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { GATEWAY_LOG_CONFIG } from "../../shared/constants";
import type { GatewayLogCleanupEntry, GatewayLogCleanupFilter } from "../../shared/types";

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

const requestRing: GatewayRequestLog[] = [];
const eventRing: GatewayEventLog[] = [];
let logDirectory = "";
let pendingRequests: GatewayRequestLog[] = [];
let pendingEvents: GatewayEventLog[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushPromise: Promise<void> | null = null;

export function setGatewayLogPath(dir: string) {
  logDirectory = dir;
}

export function recordGatewayRequest(entry: Omit<GatewayRequestLog, "ts">) {
  const full: GatewayRequestLog = { ...entry, ts: new Date().toISOString() };
  requestRing.push(full);
  if (requestRing.length > GATEWAY_LOG_CONFIG.requestRingCapacity) requestRing.shift();
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
  if (eventRing.length > GATEWAY_LOG_CONFIG.eventRingCapacity) eventRing.shift();
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
  }, GATEWAY_LOG_CONFIG.flushIntervalMs);
}

async function flushToFile() {
  if (flushPromise) return flushPromise;
  if (pendingRequests.length === 0 && pendingEvents.length === 0) return;
  const requests = pendingRequests;
  const events = pendingEvents;
  pendingRequests = [];
  pendingEvents = [];
  flushPromise = (async () => {
    try {
      await fs.mkdir(logDirectory, { recursive: true });
      const filePath = path.join(logDirectory, GATEWAY_LOG_CONFIG.fileName);
      const lines = [
        ...events.map((event) => JSON.stringify(event)),
        ...requests.map((request) => JSON.stringify(request))
      ];
      const payload = `${lines.join("\n")}\n`;
      const currentSize = await fs.stat(filePath).then((stat) => stat.size).catch(() => 0);
      if (currentSize > 0 && currentSize + Buffer.byteLength(payload, "utf8") > GATEWAY_LOG_CONFIG.maxFileBytes) {
        const rotatedPath = path.join(logDirectory, GATEWAY_LOG_CONFIG.rotatedFileName);
        await fs.rm(rotatedPath, { force: true });
        await fs.rename(filePath, rotatedPath);
      }
      await fs.appendFile(filePath, payload, "utf8");
    } catch {
      // 日志落盘失败不应影响网关转发；记录已在内存环形缓冲中，仍可供近期异常查询。
    }
  })().finally(() => {
    flushPromise = null;
  });
  await flushPromise;
}

// 测试与运维查询时，确保已缓冲的日志写入磁盘后再读取。
export async function flushGatewayLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushToFile();
}

export async function getGatewayFileCleanupEntries(filter: Omit<GatewayLogCleanupFilter, "scope"> = {}): Promise<GatewayLogCleanupEntry[]> {
  await flushGatewayLogs();
  if (!logDirectory) return [];
  const entries: GatewayLogCleanupEntry[] = [];
  for (const fileName of [GATEWAY_LOG_CONFIG.fileName, GATEWAY_LOG_CONFIG.rotatedFileName]) {
    const filePath = path.join(logDirectory, fileName);
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) continue;
    content.split(/\r?\n/).forEach((line, index) => {
      if (!line) return;
      const entry = parseGatewayLogLine(line);
      if (!entry || !matchesGatewayLog(entry, { ...filter, scope: "file" })) return;
      entries.push(toGatewayCleanupEntry(entry, fileName, index, line));
    });
  }
  return entries;
}

export async function deleteGatewayFileEntries(entryIds: string[]) {
  const ids = new Set(entryIds.filter((id) => typeof id === "string" && id.trim()));
  if (ids.size === 0) return { deletedFiles: 0, deletedEntries: 0 };
  await flushGatewayLogs();
  if (!logDirectory) return { deletedFiles: 0, deletedEntries: 0 };
  const deletedEntries: Array<GatewayRequestLog | GatewayEventLog> = [];
  let deletedCount = 0;
  let deletedFiles = 0;
  for (const fileName of [GATEWAY_LOG_CONFIG.fileName, GATEWAY_LOG_CONFIG.rotatedFileName]) {
    const filePath = path.join(logDirectory, fileName);
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    const keptLines: string[] = [];
    lines.forEach((line, index) => {
      if (!line) return;
      const entry = parseGatewayLogLine(line);
      const id = entry ? createGatewayFileEntryId(fileName, index, line) : "";
      if (entry && ids.has(id)) {
        deletedEntries.push(entry);
        deletedCount += 1;
      } else {
        keptLines.push(line);
      }
    });
    if (deletedCount === 0 && keptLines.length === lines.filter(Boolean).length) continue;
    if (keptLines.length === 0) {
      await fs.rm(filePath, { force: true });
      deletedFiles += 1;
    } else if (keptLines.length !== lines.filter(Boolean).length) {
      await fs.writeFile(filePath, `${keptLines.join("\n")}\n`, "utf8");
    }
  }
  removeFromGatewayRings(deletedEntries);
  return { deletedFiles, deletedEntries: deletedCount };
}

export async function clearGatewayFileLogs(filter: Omit<GatewayLogCleanupFilter, "scope"> = {}) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushToFile();
  const cleanupFilter = { ...filter, scope: "file" as const };
  const remainingRequests = requestRing.filter((entry) => !matchesGatewayLog(entry, cleanupFilter));
  const remainingEvents = eventRing.filter((entry) => !matchesGatewayLog(entry, cleanupFilter));
  const deletedMemoryEntries = requestRing.length - remainingRequests.length + eventRing.length - remainingEvents.length;
  requestRing.splice(0, requestRing.length, ...remainingRequests);
  eventRing.splice(0, eventRing.length, ...remainingEvents);
  pendingRequests = pendingRequests.filter((entry) => !matchesGatewayLog(entry, cleanupFilter));
  pendingEvents = pendingEvents.filter((entry) => !matchesGatewayLog(entry, cleanupFilter));
  if (!logDirectory) return { deletedFiles: 0, deletedEntries: deletedMemoryEntries };
  const files = [
    path.join(logDirectory, GATEWAY_LOG_CONFIG.fileName),
    path.join(logDirectory, GATEWAY_LOG_CONFIG.rotatedFileName)
  ];
  let deletedFiles = 0;
  // 已落盘的内存环形记录与文件内容是同一份日志，统计时只计文件记录，避免重复计算。
  let deletedEntries = 0;
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) continue;
    if (!hasCleanupCriteria(cleanupFilter)) {
      deletedEntries += content.split(/\r?\n/).filter(Boolean).length;
      await fs.rm(filePath, { force: true });
      deletedFiles += 1;
      continue;
    }
    const lines = content.split(/\r?\n/);
    const keptLines: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      const entry = parseGatewayLogLine(line);
      if (!entry || !matchesGatewayLog(entry, cleanupFilter)) {
        keptLines.push(line);
      } else {
        deletedEntries += 1;
      }
    }
    if (keptLines.length === 0) {
      await fs.rm(filePath, { force: true });
      deletedFiles += 1;
    } else if (keptLines.length !== lines.filter(Boolean).length) {
      await fs.writeFile(filePath, `${keptLines.join("\n")}\n`, "utf8");
    }
  }
  return { deletedFiles, deletedEntries };
}

function parseGatewayLogLine(line: string): GatewayRequestLog | GatewayEventLog | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed.ts === "string" && typeof parsed.event === "string"
      ? parsed as GatewayEventLog
      : typeof parsed.ts === "string" && typeof parsed.outcome === "string"
        ? parsed as GatewayRequestLog
        : null;
  } catch {
    return null;
  }
}

function toGatewayCleanupEntry(entry: GatewayRequestLog | GatewayEventLog, fileName: string, lineIndex: number, line: string): GatewayLogCleanupEntry {
  if ("outcome" in entry) {
    return {
      id: createGatewayFileEntryId(fileName, lineIndex, line),
      source: "file",
      fileName,
      createdAt: entry.ts,
      vendorId: entry.vendorId,
      providerId: entry.provider as GatewayLogCleanupEntry["providerId"],
      outcome: entry.outcome,
      upstreamStatus: entry.upstreamStatus,
      durationMs: entry.durationMs,
      errorCode: entry.errorCode,
      errorMessage: entry.error,
      method: entry.method,
      path: entry.path
    };
  }
  return {
    id: createGatewayFileEntryId(fileName, lineIndex, line),
    source: "file",
    fileName,
    createdAt: entry.ts,
    outcome: "",
    event: entry.event,
    level: entry.level
  };
}

function createGatewayFileEntryId(fileName: string, lineIndex: number, line: string) {
  return `${fileName}:${lineIndex}:${crypto.createHash("sha1").update(line).digest("hex")}`;
}

function removeFromGatewayRings(entries: Array<GatewayRequestLog | GatewayEventLog>) {
  const serialized = new Set(entries.map((entry) => JSON.stringify(entry)));
  const remainingRequests = requestRing.filter((entry) => !serialized.has(JSON.stringify(entry)));
  const remainingEvents = eventRing.filter((entry) => !serialized.has(JSON.stringify(entry)));
  requestRing.splice(0, requestRing.length, ...remainingRequests);
  eventRing.splice(0, eventRing.length, ...remainingEvents);
  pendingRequests = pendingRequests.filter((entry) => !serialized.has(JSON.stringify(entry)));
  pendingEvents = pendingEvents.filter((entry) => !serialized.has(JSON.stringify(entry)));
}

function matchesGatewayLog(entry: GatewayRequestLog | GatewayEventLog, filter: GatewayLogCleanupFilter) {
  if (filter.periodStart && entry.ts < filter.periodStart) return false;
  if (filter.periodEnd && entry.ts > filter.periodEnd) return false;
  if (filter.vendorId && (!("vendorId" in entry) || entry.vendorId !== filter.vendorId)) return false;
  if (filter.outcome && (!("outcome" in entry) || entry.outcome !== filter.outcome)) return false;
  return true;
}

function hasCleanupCriteria(filter: GatewayLogCleanupFilter) {
  return Boolean(filter.vendorId || filter.outcome || filter.periodStart || filter.periodEnd);
}
