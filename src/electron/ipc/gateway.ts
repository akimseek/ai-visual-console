import { ipcMain } from "electron";
import {
  getGatewayCircuitDurationSeconds,
  getGatewayCircuitFailureThreshold,
  getGatewayEnabled,
  getGatewayExternalApiStatus,
  getGatewayFailureThreshold,
  getGatewayPort,
  setGatewayCircuitDurationSeconds,
  setGatewayCircuitFailureThreshold,
  setGatewayEnabled,
  setGatewayExternalApiEnabled,
  setGatewayFailureThreshold,
  setGatewayPort,
  rotateGatewayExternalApiToken
} from "../core/settings";
import { getVendorGatewayPort, invalidateWslGatewayCache, startVendorGatewayIfEnabled, stopVendorGateway } from "../gateway/vendor-gateway";
import {
  requireGatewayCircuitDurationSeconds,
  requireGatewayCircuitFailureThreshold,
  requireGatewayFailureThreshold,
  requireGatewayPort,
  requireGatewayFailoverRuleInput,
  requireString,
  requireBoolean
} from "./validation";
import { deleteGatewayRequestEntries, getGatewayFailureDiagnosticsPage, getGatewayRequestCleanupEntries, getGatewayUsageReport, getGatewayUsageSummary, getRecentGatewayFailures } from "../gateway/gateway-request-store";
import { deleteGatewayFileEntries, getGatewayFileCleanupEntries } from "../gateway/gateway-log";
import { listGatewayVendorHealth, resetGatewayVendorHealth } from "../gateway/gateway-resilience";
import {
  deleteGatewayFailoverRule,
  listGatewayFailoverRules,
  saveGatewayFailoverRule,
  setGatewayFailoverRuleEnabled
} from "../gateway/gateway-failover-rules";

export function registerGatewayIpcHandlers() {
  ipcMain.handle("gateway:get-external-api-status", () => getGatewayExternalApiStatus());
  ipcMain.handle("gateway:set-external-api-enabled", async (_event, enabled: unknown) => {
    const checkedEnabled = requireBoolean(enabled, "enabled");
    if (checkedEnabled && !await getGatewayEnabled()) throw new Error("请先开启本地 Gateway，再启用外部 API。");
    if (checkedEnabled && !(await getGatewayExternalApiStatus()).tokenConfigured) throw new Error("请先生成外部 API 访问令牌。");
    await setGatewayExternalApiEnabled(checkedEnabled);
    return getGatewayExternalApiStatus();
  });
  ipcMain.handle("gateway:rotate-external-api-token", () => rotateGatewayExternalApiToken());
  ipcMain.handle("gateway:get-port", async () => ({
    enabled: await getGatewayEnabled(),
    configuredPort: await getGatewayPort(),
    activePort: getVendorGatewayPort(),
    configuredFailureThreshold: await getGatewayFailureThreshold(),
    configuredCircuitFailureThreshold: await getGatewayCircuitFailureThreshold(),
    configuredCircuitDurationSeconds: await getGatewayCircuitDurationSeconds()
  }));
  ipcMain.handle("gateway:set-enabled", async (_event, enabled: unknown) => {
    const checkedEnabled = requireBoolean(enabled, "enabled");
    await setGatewayEnabled(checkedEnabled);
    try {
      if (checkedEnabled) await startVendorGatewayIfEnabled();
      else await stopVendorGateway();
    } catch (error) {
      if (checkedEnabled) await setGatewayEnabled(false);
      throw error;
    }
    return {
      enabled: checkedEnabled,
      configuredPort: await getGatewayPort(),
      activePort: getVendorGatewayPort(),
      configuredFailureThreshold: await getGatewayFailureThreshold(),
      configuredCircuitFailureThreshold: await getGatewayCircuitFailureThreshold(),
      configuredCircuitDurationSeconds: await getGatewayCircuitDurationSeconds()
    };
  });
  ipcMain.handle("gateway:set-port", async (
    _event,
    port: unknown,
    threshold: unknown,
    circuitFailureThreshold: unknown,
    circuitDurationSeconds: unknown
  ) => {
    const checkedPort = requireGatewayPort(port);
    const checkedThreshold = requireGatewayFailureThreshold(threshold);
    const checkedCircuitFailureThreshold = requireGatewayCircuitFailureThreshold(circuitFailureThreshold);
    const checkedCircuitDurationSeconds = requireGatewayCircuitDurationSeconds(circuitDurationSeconds);
    const configuredPort = await setGatewayPort(checkedPort);
    const configuredFailureThreshold = await setGatewayFailureThreshold(checkedThreshold);
    const configuredCircuitFailureThreshold = await setGatewayCircuitFailureThreshold(checkedCircuitFailureThreshold);
    const configuredCircuitDurationSeconds = await setGatewayCircuitDurationSeconds(checkedCircuitDurationSeconds);
    // 端口变更后，WSL 探测缓存中的 host:port 已失效，必须清空以便下次重新探测。
    invalidateWslGatewayCache();
    const activePort = getVendorGatewayPort();
    return {
      enabled: await getGatewayEnabled(),
      configuredPort,
      activePort,
      configuredFailureThreshold,
      configuredCircuitFailureThreshold,
      configuredCircuitDurationSeconds,
      applied: activePort === 0 || configuredPort === 0 || activePort === configuredPort
    };
  });
  ipcMain.handle("gateway:get-vendor-health", () => listGatewayVendorHealth());
  ipcMain.handle("gateway:reset-vendor-health", (_event, vendorId: unknown) =>
    resetGatewayVendorHealth(typeof vendorId === "string" && vendorId.trim() ? vendorId.trim() : undefined));
  ipcMain.handle("gateway:list-failover-rules", () => listGatewayFailoverRules());
  ipcMain.handle("gateway:save-failover-rule", (_event, input: unknown) =>
    saveGatewayFailoverRule(requireGatewayFailoverRuleInput(input)));
  ipcMain.handle("gateway:delete-failover-rule", (_event, ruleId: unknown) =>
    deleteGatewayFailoverRule(requireString(ruleId, "ruleId")));
  ipcMain.handle("gateway:set-failover-rule-enabled", (_event, ruleId: unknown, enabled: unknown) =>
    setGatewayFailoverRuleEnabled(requireString(ruleId, "ruleId"), requireBoolean(enabled, "enabled")));
  /* legacy conditional cleanup handler removed; deletion is ID-scoped below. */
  /* ipcMain.handle("gateway:clear-logs", async (_event, filter: unknown) => {
    if (!filter || typeof filter !== "object") throw new Error("Gateway 日志清理条件无效。");
    const input = filter as Record<string, unknown>;
    const scope = input.scope === "file" || input.scope === "request" || input.scope === "both" ? input.scope : "both";
    const cleanup = {
      vendorId: typeof input.vendorId === "string" ? input.vendorId : "",
      outcome: input.outcome === "ok" || input.outcome === "client-aborted" || input.outcome === "timeout" || input.outcome === "error" ? input.outcome : "",
      periodStart: typeof input.periodStart === "string" ? input.periodStart : "",
      periodEnd: typeof input.periodEnd === "string" ? input.periodEnd : ""
    } as const;
    const [fileResult, requestResult] = await Promise.all([
      scope === "request" ? Promise.resolve({ deletedFiles: 0, deletedEntries: 0 }) : clearGatewayFileLogs(cleanup),
      scope === "file" ? Promise.resolve({ deleted: 0 }) : clearGatewayRequestLogs(cleanup)
    ]);
    return {
      deletedFileEntries: fileResult.deletedEntries,
      deletedRequestEntries: requestResult.deleted,
      deletedFiles: fileResult.deletedFiles
    };
  }); */
  ipcMain.handle("gateway:query-logs", async (_event, filter: unknown, page: unknown, pageSize: unknown) => {
    const cleanup = parseCleanupFilter(filter);
    const requestedPage = typeof page === "number" && Number.isFinite(page) ? page : 1;
    const requestedPageSize = typeof pageSize === "number" && Number.isFinite(pageSize) ? pageSize : 10;
    const safePageSize = Math.min(50, Math.max(1, Math.floor(requestedPageSize)));
    const [fileEntries, requestEntries] = await Promise.all([
      cleanup.scope === "request" ? Promise.resolve([]) : getGatewayFileCleanupEntries(cleanup),
      cleanup.scope === "file" ? Promise.resolve([]) : getGatewayRequestCleanupEntries(cleanup)
    ]);
    const allEntries = [...fileEntries, ...requestEntries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const safePage = Math.max(1, Math.floor(requestedPage));
    return {
      items: allEntries.slice((safePage - 1) * safePageSize, safePage * safePageSize),
      total: allEntries.length,
      page: safePage,
      pageSize: safePageSize
    };
  });
  ipcMain.handle("gateway:delete-log-entries", async (_event, selections: unknown) => {
    if (!Array.isArray(selections)) throw new Error("Gateway 日志删除记录无效。");
    const fileIds: string[] = [];
    const requestIds: string[] = [];
    for (const item of selections) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id.trim()) continue;
      if (record.source === "file") fileIds.push(record.id);
      if (record.source === "request") requestIds.push(record.id);
    }
    const [fileResult, requestResult] = await Promise.all([
      deleteGatewayFileEntries(fileIds),
      deleteGatewayRequestEntries(requestIds)
    ]);
    return {
      deletedFileEntries: fileResult.deletedEntries,
      deletedRequestEntries: requestResult.deleted,
      deletedFiles: fileResult.deletedFiles
    };
  });
  ipcMain.handle("gateway:get-usage-summary", (_event, periodStart: unknown, periodEnd: unknown) => {
    if (typeof periodStart !== "string" || typeof periodEnd !== "string") throw new Error("统计时间范围无效。");
    return getGatewayUsageSummary(periodStart, periodEnd);
  });
  ipcMain.handle("gateway:get-usage-report", (_event, periodStart: unknown, periodEnd: unknown) => {
    if (typeof periodStart !== "string" || typeof periodEnd !== "string") throw new Error("统计时间范围无效。");
    return getGatewayUsageReport(periodStart, periodEnd);
  });
  ipcMain.handle("gateway:get-recent-failures", () => getRecentGatewayFailures());
  ipcMain.handle("gateway:get-failure-diagnostics", (_event, page: unknown, pageSize: unknown, vendorId: unknown, outcome: unknown, periodStart: unknown, periodEnd: unknown, providerId: unknown) => {
    const requestedPage = typeof page === "number" && Number.isFinite(page) ? page : 1;
    const requestedPageSize = typeof pageSize === "number" && Number.isFinite(pageSize) ? pageSize : 10;
    const requestedVendorId = typeof vendorId === "string" ? vendorId : "";
    const requestedOutcome = outcome === "error" || outcome === "timeout" ? outcome : "";
    const requestedPeriodStart = typeof periodStart === "string" ? periodStart : "";
    const requestedPeriodEnd = typeof periodEnd === "string" ? periodEnd : "";
    const requestedProviderId = providerId === "codex" || providerId === "claude" || providerId === "gemini" || providerId === "qoder" ? providerId : "";
    return getGatewayFailureDiagnosticsPage(requestedPage, requestedPageSize, requestedVendorId, requestedOutcome, requestedPeriodStart, requestedPeriodEnd, requestedProviderId);
  });
}

function parseCleanupFilter(filter: unknown) {
  const input = filter && typeof filter === "object" ? filter as Record<string, unknown> : {};
  return {
    scope: input.scope === "file" || input.scope === "request" || input.scope === "both" ? input.scope : "both",
    vendorId: typeof input.vendorId === "string" ? input.vendorId : "",
    outcome: input.outcome === "ok" || input.outcome === "client-aborted" || input.outcome === "timeout" || input.outcome === "error" ? input.outcome : "",
    periodStart: typeof input.periodStart === "string" ? input.periodStart : "",
    periodEnd: typeof input.periodEnd === "string" ? input.periodEnd : ""
  } as const;
}
