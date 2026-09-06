import { contextBridge, ipcRenderer } from "electron";
import type { CodexConsoleApi as CodexConsoleApiContract } from "../shared/codex-console-api";
import { createAppApi } from "./preload/app-api";
import { createGatewayApi } from "./preload/gateway-api";
import { createSessionApi } from "./preload/session-api";
import { createSkillApi } from "./preload/skill-api";
import { createTerminalApi } from "./preload/terminal-api";
import { createVendorApi } from "./preload/vendor-api";

// 只在这里装配各业务域 API，保持暴露给渲染进程的对象名称兼容。
const api = {
  ...createAppApi(ipcRenderer),
  ...createGatewayApi(ipcRenderer),
  ...createVendorApi(ipcRenderer),
  ...createSessionApi(ipcRenderer),
  ...createSkillApi(ipcRenderer),
  ...createTerminalApi(ipcRenderer)
} satisfies CodexConsoleApiContract;

contextBridge.exposeInMainWorld("codexConsole", api);

export type CodexConsoleApi = CodexConsoleApiContract;
