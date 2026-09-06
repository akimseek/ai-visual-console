import type { AiProviderId, ApiVendor, GatewayVendorHealth, GatewayVendorHealthStatus } from "../types";
import { readAppDatabase, updateAppDatabase } from "../core/app-database";
import { getGatewayCircuitDurationSeconds, getGatewayCircuitFailureThreshold } from "../core/settings";

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const HEALTH_SUCCESS_PERSIST_INTERVAL_MS = 5_000;

type HealthState = GatewayVendorHealth & {
  failures: number[];
  lastPersistedAt?: number;
  persistedStatus?: GatewayVendorHealthStatus;
};
const states = new Map<string, HealthState>();
let schemaPromise: Promise<void> | null = null;
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

type HealthRow = {
  vendor_id: string;
  provider_id: AiProviderId;
  status: GatewayVendorHealthStatus;
  failure_count: number;
  success_count: number;
  failure_rate: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  circuit_until: string | null;
  last_failure_reason: string | null;
};

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = updateAppDatabase((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_vendor_health (
        vendor_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        failure_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_rate REAL NOT NULL DEFAULT 0,
        last_failure_at TEXT,
        last_success_at TEXT,
        circuit_until TEXT,
        last_failure_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_vendor_health_provider
        ON gateway_vendor_health(provider_id, status);
    `)).finally(() => { schemaPromise = null; });
  }
  await schemaPromise;
}

export async function hydrateGatewayVendorHealth() {
  if (hydrated) return;
  // 首次并发请求共享同一次数据库读取，避免多个请求同时初始化健康状态。
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = loadGatewayVendorHealth().finally(() => {
    hydrationPromise = null;
  });
  return hydrationPromise;
}

async function loadGatewayVendorHealth() {
  try {
    await ensureSchema();
    const rows = await readAppDatabase((db) => db.prepare("SELECT * FROM gateway_vendor_health").all() as HealthRow[]);
    for (const row of rows) {
      states.set(row.vendor_id, {
        vendorId: row.vendor_id,
        providerId: row.provider_id,
        status: normalizeStatus(row.status, row.circuit_until),
        failureCount: row.failure_count,
        successCount: row.success_count,
        failureRate: row.failure_rate,
        lastFailureAt: row.last_failure_at || undefined,
        lastSuccessAt: row.last_success_at || undefined,
        circuitUntil: row.circuit_until || undefined,
        lastFailureReason: row.last_failure_reason || undefined,
        failures: row.status === "open" ? [Date.now()] : [],
        lastPersistedAt: Date.now(),
        persistedStatus: normalizeStatus(row.status, row.circuit_until)
      });
    }
    hydrated = true;
  } catch {
    // 健康状态只是路由辅助信息；数据库不可用时降级为内存状态，不能因此拒绝所有网关请求。
    // 将失败结果视为本次进程生命周期内的初始化完成，避免数据库异常时每个请求重复尝试建表和读库。
    // 健康状态会继续由内存 Map 维护；数据库恢复后由 resetGatewayVendorHealth 主动重新建立持久化状态。
    hydrated = true;
  }
}

export async function listGatewayVendorHealth(): Promise<GatewayVendorHealth[]> {
  await hydrateGatewayVendorHealth();
  await ensureSchema();
  const rows = await readAppDatabase((db) => db.prepare("SELECT * FROM gateway_vendor_health ORDER BY provider_id, vendor_id").all() as HealthRow[]);
  return rows.map((row) => ({
    vendorId: row.vendor_id,
    providerId: row.provider_id,
    status: normalizeStatus(row.status, row.circuit_until),
    failureCount: row.failure_count,
    successCount: row.success_count,
    failureRate: row.failure_rate,
    lastFailureAt: row.last_failure_at || undefined,
    lastSuccessAt: row.last_success_at || undefined,
    circuitUntil: row.circuit_until || undefined,
    lastFailureReason: row.last_failure_reason || undefined
  }));
}

export function chooseVendor(vendors: ApiVendor[], providerId: AiProviderId, preferredVendorId?: string) {
  const candidates = eligibleVendors(vendors, providerId).sort((left, right) => {
    // 首选路由供应商仍优先；发生故障切换后，其余候选按 sort 升序选择。
    const preferredDelta = (left.id === preferredVendorId ? -1 : 0) - (right.id === preferredVendorId ? -1 : 0);
    return preferredDelta || compareVendorOrder(left, right);
  });
  return candidates[0];
}

// 失败转移按 sort 正序环形选择；attemptedIds 防止同一请求重复尝试同一供应商。
export function chooseNextVendor(
  vendors: ApiVendor[],
  providerId: AiProviderId,
  currentVendorId: string,
  attemptedIds: ReadonlySet<string> = new Set()
) {
  // 这里不能直接使用 eligibleVendors：当前供应商刚失败后可能已进入熔断，
  // 仍需保留它在完整排序中的位置，才能从它的下一个 sort 值开始环形选择。
  const candidates = vendors.filter((vendor) => isConfiguredCandidate(vendor, providerId)).sort(compareVendorOrder);
  if (candidates.length === 0) return undefined;
  const currentIndex = candidates.findIndex((vendor) => vendor.id === currentVendorId);
  const start = currentIndex >= 0 ? currentIndex + 1 : 0;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(start + offset) % candidates.length];
    if (!attemptedIds.has(candidate.id) && !isCircuitOpen(candidate.id)) return candidate;
  }
  return undefined;
}

function eligibleVendors(vendors: ApiVendor[], providerId: AiProviderId) {
  return vendors
    .filter((vendor) => isConfiguredCandidate(vendor, providerId))
    .filter((vendor) => !isCircuitOpen(vendor.id));
}

function isConfiguredCandidate(vendor: ApiVendor, providerId: AiProviderId) {
  return vendor.providerId === providerId && vendor.enabled && Boolean(vendor.apiKey.trim()) && Boolean(vendor.apiBaseUrl.trim());
}

function compareVendorOrder(left: ApiVendor, right: ApiVendor) {
  return (left.sort || 0) - (right.sort || 0) || left.createdAt.localeCompare(right.createdAt);
}

export function isCircuitOpen(vendorId: string) {
  const state = states.get(vendorId);
  if (!state?.circuitUntil) return false;
  if (Date.parse(state.circuitUntil) <= Date.now()) {
    state.status = "half-open";
    state.circuitUntil = undefined;
    return false;
  }
  return state.status === "open";
}

export async function recordGatewayVendorSuccess(vendor: ApiVendor) {
  const state = stateFor(vendor);
  state.successCount += 1;
  state.status = "healthy";
  state.circuitUntil = undefined;
  state.failures = [];
  state.lastSuccessAt = new Date().toISOString();
  state.failureRate = state.failureCount + state.successCount > 0
    ? state.failureCount / (state.failureCount + state.successCount)
    : 0;
  if (shouldPersistHealthState(state)) await persist(state);
}

export async function recordGatewayVendorFailure(vendor: ApiVendor, reason: string) {
  const state = stateFor(vendor);
  const now = Date.now();
  const [failureThreshold, durationSeconds] = await Promise.all([
    getGatewayCircuitFailureThreshold(),
    getGatewayCircuitDurationSeconds()
  ]);
  state.failures = state.failures.filter((timestamp) => now - timestamp < FAILURE_WINDOW_MS);
  state.failures.push(now);
  state.failureCount += 1;
  state.lastFailureAt = new Date(now).toISOString();
  state.lastFailureReason = reason.slice(0, 240);
  state.failureRate = state.failureCount + state.successCount > 0
    ? state.failureCount / (state.failureCount + state.successCount)
    : 1;
  state.status = state.failures.length >= failureThreshold ? "open" : "degraded";
  state.circuitUntil = state.status === "open" ? new Date(now + durationSeconds * 1000).toISOString() : undefined;
  await persist(state);
}

export async function resetGatewayVendorHealth(vendorId?: string) {
  await ensureSchema();
  if (vendorId) states.delete(vendorId);
  else states.clear();
  hydrated = true;
  await updateAppDatabase((db) => {
    if (vendorId) db.prepare("DELETE FROM gateway_vendor_health WHERE vendor_id = ?").run(vendorId);
    else db.prepare("DELETE FROM gateway_vendor_health").run();
  });
}

function stateFor(vendor: ApiVendor): HealthState {
  const existing = states.get(vendor.id);
  if (existing) return existing;
  const state: HealthState = {
    vendorId: vendor.id,
    providerId: vendor.providerId,
    status: "healthy",
    failureCount: 0,
    successCount: 0,
    failureRate: 0,
    failures: []
  };
  states.set(vendor.id, state);
  return state;
}

function shouldPersistHealthState(state: HealthState) {
  return state.persistedStatus !== state.status
    || state.lastPersistedAt === undefined
    || Date.now() - state.lastPersistedAt >= HEALTH_SUCCESS_PERSIST_INTERVAL_MS;
}

async function persist(state: HealthState) {
  try {
    await ensureSchema();
    await updateAppDatabase((db) => db.prepare(`
      INSERT INTO gateway_vendor_health
        (vendor_id, provider_id, status, failure_count, success_count, failure_rate, last_failure_at, last_success_at, circuit_until, last_failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vendor_id) DO UPDATE SET
        status = excluded.status,
        failure_count = excluded.failure_count,
        success_count = excluded.success_count,
        failure_rate = excluded.failure_rate,
        last_failure_at = excluded.last_failure_at,
        last_success_at = excluded.last_success_at,
        circuit_until = excluded.circuit_until,
        last_failure_reason = excluded.last_failure_reason
    `).run(
      state.vendorId,
      state.providerId,
      state.status,
      state.failureCount,
      state.successCount,
      state.failureRate,
      state.lastFailureAt || null,
      state.lastSuccessAt || null,
      state.circuitUntil || null,
      state.lastFailureReason || null
    ));
    state.lastPersistedAt = Date.now();
    state.persistedStatus = state.status;
  } catch {
    // 健康状态写入失败不能影响已经完成的 Gateway 请求。
  }
}

function normalizeStatus(status: GatewayVendorHealthStatus, circuitUntil: string | null): GatewayVendorHealthStatus {
  if (status === "open" && (!circuitUntil || Date.parse(circuitUntil) <= Date.now())) return "half-open";
  return status;
}
