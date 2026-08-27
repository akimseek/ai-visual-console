import { ipcMain } from "electron";
import {
  listApiVendors,
  listApiVendorSummaries,
  saveApiVendor,
  isApiKeyEncryptionAvailable,
  deleteApiVendor,
  readApiVendorConfigFiles,
  enableApiVendor,
  listVendorModels
} from "../vendorManager";
import { switchTerminalVendor } from "../terminalSessions";
import { findTargetForVendor } from "../mainHelpers";
import {
  requireApiVendorInput,
  requireString,
  requireApiVendorConfigReadRequest,
  requireApiVendorEnableRequest
} from "../ipcValidation";

export function registerVendorIpcHandlers() {
  ipcMain.handle("vendor:list", async (_event, targetId: unknown) => {
    const checkedTargetId = typeof targetId === "string" && targetId.trim() ? targetId.trim() : "";
    const target = checkedTargetId ? await findTargetForVendor(checkedTargetId) : null;
    return listApiVendorSummaries(target);
  });
  ipcMain.handle("vendor:save", async (_event, input: unknown) => {
    const saved = await saveApiVendor(requireApiVendorInput(input));
    return { ...saved, apiKey: "" };
  });
  ipcMain.handle("vendor:encryption-available", () => isApiKeyEncryptionAvailable());
  ipcMain.handle("vendor:delete", (_event, vendorId: unknown) => deleteApiVendor(requireString(vendorId, "vendorId")));
  ipcMain.handle("vendor:read-configs", async (_event, request: unknown) => {
    const checked = requireApiVendorConfigReadRequest(request);
    const target = checked.targetId ? await findTargetForVendor(checked.targetId) : null;
    return readApiVendorConfigFiles(checked, target);
  });
  ipcMain.handle("vendor:enable", async (_event, request: unknown) => {
    const checked = requireApiVendorEnableRequest(request);
    const target = checked.targetId ? await findTargetForVendor(checked.targetId) : null;
    const result = await enableApiVendor(checked, target);
    if (!checked.terminalId) return result;
    const vendor = (await listApiVendors()).find((item) => item.id === result.vendorId);
    if (!vendor) return result;
    const switchResult = switchTerminalVendor(checked.terminalId, vendor.providerId, vendor.id);
    return { ...result, switched: switchResult.switched === 1, switchReason: switchResult.reason };
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
}
