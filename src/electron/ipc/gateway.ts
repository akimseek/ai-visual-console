import { ipcMain } from "electron";
import {
  getGatewayCircuitDurationSeconds,
  getGatewayCircuitFailureThreshold,
  getGatewayFailureThreshold,
  getGatewayPort,
  setGatewayCircuitDurationSeconds,
  setGatewayCircuitFailureThreshold,
  setGatewayFailureThreshold,
  setGatewayPort
} from "../core/settings";
import { getVendorGatewayPort, invalidateWslGatewayCache } from "../gateway/vendor-gateway";
import {
  requireGatewayCircuitDurationSeconds,
  requireGatewayCircuitFailureThreshold,
  requireGatewayFailureThreshold,
  requireGatewayPort
} from "./validation";
import { getGatewayUsageSummary } from "../gateway/gateway-request-store";
import { listGatewayVendorHealth, resetGatewayVendorHealth } from "../gateway/gateway-resilience";

export function registerGatewayIpcHandlers() {
  ipcMain.handle("gateway:get-port", async () => ({
    configuredPort: await getGatewayPort(),
    activePort: getVendorGatewayPort(),
    configuredFailureThreshold: await getGatewayFailureThreshold(),
    configuredCircuitFailureThreshold: await getGatewayCircuitFailureThreshold(),
    configuredCircuitDurationSeconds: await getGatewayCircuitDurationSeconds()
  }));
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
      configuredPort,
      activePort,
      configuredFailureThreshold,
      configuredCircuitFailureThreshold,
      configuredCircuitDurationSeconds,
      applied: activePort === 0 || activePort === configuredPort
    };
  });
  ipcMain.handle("gateway:get-vendor-health", () => listGatewayVendorHealth());
  ipcMain.handle("gateway:reset-vendor-health", (_event, vendorId: unknown) =>
    resetGatewayVendorHealth(typeof vendorId === "string" && vendorId.trim() ? vendorId.trim() : undefined));
  ipcMain.handle("gateway:get-usage-summary", (_event, periodStart: unknown, periodEnd: unknown) => {
    if (typeof periodStart !== "string" || typeof periodEnd !== "string") throw new Error("统计时间范围无效。");
    return getGatewayUsageSummary(periodStart, periodEnd);
  });
}
