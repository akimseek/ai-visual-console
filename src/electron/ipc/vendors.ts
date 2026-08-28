import { ipcMain } from "electron";
import {
  listApiVendors,
  saveApiVendor,
  deleteApiVendor,
  readApiVendorConfigFiles,
  enableApiVendor,
  listVendorModels
  ,setApiVendorEnabled
} from "../vendorManager";
import { listModels as listQoderModels } from "../qoderProvider";
import {
  listVendorBalanceSnapshots,
  refreshVendorBalance,
  refreshVendorBalances
} from "../vendorBalance";
import { listGatewayVendorHealth } from "../gatewayResilience";
import { switchTerminalVendor } from "../terminalSessions";
import { invalidateGatewayVendorSnapshot } from "../vendorRegistry";
import { findTargetForVendor } from "../mainHelpers";
import {
  requireApiVendorInput,
  requireString,
  requireApiVendorConfigReadRequest,
  requireApiVendorEnableRequest
  ,requireBoolean
} from "../ipcValidation";

export function registerVendorIpcHandlers() {
  ipcMain.handle("vendor:list", async (_event, targetId: unknown) => {
    const checkedTargetId = typeof targetId === "string" && targetId.trim() ? targetId.trim() : "";
    const target = checkedTargetId ? await findTargetForVendor(checkedTargetId) : null;
    // 供应商管理需要在编辑时回显 API Key；网关日志和其他接口不通过此 IPC 暴露密钥。
    const vendors = await listApiVendors(target);
    const balances = await listVendorBalanceSnapshots();
    const health = new Map((await listGatewayVendorHealth()).map((item) => [item.vendorId, item]));
    return vendors.map((vendor) => {
      const state = balances[vendor.id];
      const healthState = health.get(vendor.id);
      return state || healthState ? {
        ...vendor,
        ...(state ? { balance: {
          remaining: state.remaining,
          total: state.total,
          used: state.used,
          unit: state.unit,
          planName: state.planName,
          isValid: state.isValid
        },
        balanceStatus: state.status,
        balanceError: state.error,
        balanceQueriedAt: state.queriedAt } : {}),
        gatewayHealth: healthState
      } : vendor;
    });
  });
  ipcMain.handle("vendor:save", async (_event, input: unknown) => {
    const saved = await saveApiVendor(requireApiVendorInput(input));
    invalidateGatewayVendorSnapshot();
    return saved;
  });
  ipcMain.handle("vendor:delete", async (_event, vendorId: unknown) => {
    const result = await deleteApiVendor(requireString(vendorId, "vendorId"));
    invalidateGatewayVendorSnapshot();
    return result;
  });
  ipcMain.handle("vendor:read-configs", async (_event, request: unknown) => {
    const checked = requireApiVendorConfigReadRequest(request);
    const target = checked.targetId ? await findTargetForVendor(checked.targetId) : null;
    return readApiVendorConfigFiles(checked, target);
  });
  ipcMain.handle("vendor:enable", async (_event, request: unknown) => {
    const checked = requireApiVendorEnableRequest(request);
    const target = checked.targetId ? await findTargetForVendor(checked.targetId) : null;
    const result = await enableApiVendor(checked, target);
    invalidateGatewayVendorSnapshot();
    if (!checked.terminalId) return result;
    const vendor = (await listApiVendors()).find((item) => item.id === result.vendorId);
    if (!vendor) return result;
    const switchResult = switchTerminalVendor(checked.terminalId, vendor.providerId, vendor.id);
    return { ...result, switched: switchResult.switched === 1, switchReason: switchResult.reason };
  });
  ipcMain.handle("vendor:set-enabled", async (_event, vendorId: unknown, enabled: unknown) => {
    const result = await setApiVendorEnabled(requireString(vendorId, "vendorId"), requireBoolean(enabled, "enabled"));
    invalidateGatewayVendorSnapshot();
    return result;
  });
  ipcMain.handle("vendor:route-switch", async (_event, terminalId: unknown, vendorId: unknown) => {
    const checkedTerminalId = requireString(terminalId, "terminalId");
    const checkedVendorId = requireString(vendorId, "vendorId");
    const vendor = (await listApiVendors()).find((item) => item.id === checkedVendorId);
    if (!vendor) throw new Error("供应商不存在。");
    return switchTerminalVendor(checkedTerminalId, vendor.providerId, vendor.id);
  });
  ipcMain.handle("vendor:list-models", async (_event, vendorId: unknown) => {
    return listVendorModels(requireString(vendorId, "vendorId"));
  });
  ipcMain.handle("vendor:refresh-balance", async (_event, vendorId: unknown) => {
    return refreshVendorBalance(requireString(vendorId, "vendorId"));
  });
  ipcMain.handle("vendor:refresh-balances", () => refreshVendorBalances());
  ipcMain.handle("models:list", async (_event, targetId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    if (!checkedTargetId.startsWith("qoder:")) throw new Error("当前目标不支持 CLI 模型列表。");
    return listQoderModels(checkedTargetId);
  });
}
