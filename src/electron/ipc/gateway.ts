import { ipcMain } from "electron";
import { getGatewayPort, setGatewayPort } from "../settings";
import { getVendorGatewayPort, invalidateWslGatewayCache } from "../vendorGateway";
import { requireGatewayPort } from "../ipcValidation";

export function registerGatewayIpcHandlers() {
  ipcMain.handle("gateway:get-port", async () => ({
    configuredPort: await getGatewayPort(),
    activePort: getVendorGatewayPort()
  }));
  ipcMain.handle("gateway:set-port", async (_event, port: unknown) => {
    const checkedPort = requireGatewayPort(port);
    const configuredPort = await setGatewayPort(checkedPort);
    // 端口变更后，WSL 探测缓存中的 host:port 已失效，必须清空以便下次重新探测。
    invalidateWslGatewayCache();
    const activePort = getVendorGatewayPort();
    return { configuredPort, activePort, applied: activePort === 0 || activePort === configuredPort };
  });
}
