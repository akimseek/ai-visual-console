import type { IpcRenderer } from "electron";
import type {
  GatewayFailureDiagnosticsPage,
  GatewayFailureOutcomeFilter,
  GatewayLogCleanupFilter,
  GatewayLogCleanupPage,
  GatewayLogCleanupResult,
  GatewayLogCleanupSelection,
  GatewayPortStatus,
  GatewayPortUpdateResult,
  GatewayRecentFailure,
  GatewayRequestRecordedEvent,
  GatewayUsageReport,
  GatewayUsageSummary,
  GatewayVendorHealth,
  GatewayVendorSwitchEvent
} from "../types";
import { invoke, subscribe } from "./ipc-bridge";

// Gateway 设置、健康状态、统计诊断和路由事件 API。
export function createGatewayApi(ipc: IpcRenderer) {
  return {
    getGatewayPort: () => invoke<GatewayPortStatus>(ipc, "gateway:get-port"),
    setGatewayPort: (
      port: number,
      failureThreshold: number,
      circuitFailureThreshold: number,
      circuitDurationSeconds: number
    ) => invoke<GatewayPortUpdateResult>(
      ipc,
      "gateway:set-port",
      port,
      failureThreshold,
      circuitFailureThreshold,
      circuitDurationSeconds
    ),
    getGatewayVendorHealth: () => invoke<GatewayVendorHealth[]>(ipc, "gateway:get-vendor-health"),
    resetGatewayVendorHealth: (vendorId?: string) =>
      invoke<void>(ipc, "gateway:reset-vendor-health", vendorId),
    queryGatewayLogs: (filter: GatewayLogCleanupFilter, page?: number, pageSize?: number) =>
      invoke<GatewayLogCleanupPage>(ipc, "gateway:query-logs", filter, page, pageSize),
    deleteGatewayLogEntries: (selections: GatewayLogCleanupSelection[]) =>
      invoke<GatewayLogCleanupResult>(ipc, "gateway:delete-log-entries", selections),
    getGatewayUsageSummary: (periodStart: string, periodEnd: string) =>
      invoke<GatewayUsageSummary>(ipc, "gateway:get-usage-summary", periodStart, periodEnd),
    getGatewayUsageReport: (periodStart: string, periodEnd: string) =>
      invoke<GatewayUsageReport>(ipc, "gateway:get-usage-report", periodStart, periodEnd),
    getGatewayRecentFailures: () => invoke<GatewayRecentFailure[]>(ipc, "gateway:get-recent-failures"),
    getGatewayFailureDiagnostics: (
      page?: number,
      pageSize?: number,
      vendorId?: string,
      outcome?: GatewayFailureOutcomeFilter,
      periodStart?: string,
      periodEnd?: string
    ) => invoke<GatewayFailureDiagnosticsPage>(
      ipc,
      "gateway:get-failure-diagnostics",
      page,
      pageSize,
      vendorId,
      outcome,
      periodStart,
      periodEnd
    ),
    onGatewayVendorSwitched: (handler: (event: GatewayVendorSwitchEvent) => void) =>
      subscribe(ipc, "gateway:vendor-switched", handler),
    onGatewayRequestRecorded: (handler: (event: GatewayRequestRecordedEvent) => void) =>
      subscribe(ipc, "gateway:request-recorded", handler)
  };
}
