import type { IpcRenderer } from "electron";
import type {
  ApiVendor,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorEnabledResult,
  ApiVendorInput,
  VendorBalanceBatchResult,
  VendorBalanceRefreshResult,
  VendorModel
} from "../types";
import { invoke } from "./ipc-bridge";

// 供应商配置、候选池路由、模型和余额 API。
export function createVendorApi(ipc: IpcRenderer) {
  return {
    listApiVendors: (targetId?: string) => invoke<ApiVendor[]>(ipc, "vendor:list", targetId),
    saveApiVendor: (input: ApiVendorInput) => invoke<ApiVendor>(ipc, "vendor:save", input),
    deleteApiVendor: (vendorId: string) => invoke<{ deleted: boolean }>(ipc, "vendor:delete", vendorId),
    readApiVendorConfigs: (request: ApiVendorConfigReadRequest) =>
      invoke<ApiVendorConfigReadResult>(ipc, "vendor:read-configs", request),
    enableApiVendor: (request: ApiVendorEnableRequest) =>
      invoke<ApiVendorEnableResult>(ipc, "vendor:enable", request),
    setApiVendorEnabled: (vendorId: string, enabled: boolean) =>
      invoke<ApiVendorEnabledResult>(ipc, "vendor:set-enabled", vendorId, enabled),
    switchVendorRoute: (terminalId: string, vendorId: string) =>
      invoke<{
        switched: number;
        reason?: "terminal-not-found" | "gateway-not-active" | "route-not-found" | "provider-mismatch" | "vendor-not-found" | "vendor-disabled";
      }>(ipc, "vendor:route-switch", terminalId, vendorId),
    listVendorModels: (vendorId: string) => invoke<VendorModel[]>(ipc, "vendor:list-models", vendorId),
    refreshVendorBalance: (vendorId: string) =>
      invoke<VendorBalanceRefreshResult>(ipc, "vendor:refresh-balance", vendorId),
    refreshVendorBalances: () => invoke<VendorBalanceBatchResult>(ipc, "vendor:refresh-balances")
  };
}
