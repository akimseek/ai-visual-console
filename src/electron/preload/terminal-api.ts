import type { IpcRenderer } from "electron";
import type {
  OpenPathRequest,
  SystemTerminalStartRequest,
  TerminalStartRequest,
  TerminalStartResult
} from "../types";
import { invoke, subscribeArgs } from "./ipc-bridge";

// AI 终端、系统终端、剪贴板和路径操作 API。
export function createTerminalApi(ipc: IpcRenderer) {
  return {
    startTerminal: (params: TerminalStartRequest) => invoke<TerminalStartResult>(ipc, "terminal:start", params),
    startSystemTerminal: (params: SystemTerminalStartRequest) =>
      invoke<{ terminalId: string }>(ipc, "terminal:start-system", params),
    chooseDirectory: () => invoke<{ filePath?: string }>(ipc, "dialog:choose-directory"),
    writeTerminal: (terminalId: string, data: string) => invoke<void>(ipc, "terminal:write", terminalId, data),
    resizeTerminal: (terminalId: string, cols: number, rows: number) =>
      invoke<void>(ipc, "terminal:resize", terminalId, cols, rows),
    stopTerminal: (terminalId: string) => invoke<void>(ipc, "terminal:stop", terminalId),
    copyText: (text: string) => invoke<void>(ipc, "clipboard:copy-text", text),
    readText: () => invoke<string>(ipc, "clipboard:read-text"),
    onTerminalData: (handler: (terminalId: string, data: string) => void) =>
      subscribeArgs<[string, string]>(ipc, "terminal:data", handler),
    onTerminalExit: (handler: (terminalId: string, exitCode: number) => void) =>
      subscribeArgs<[string, number]>(ipc, "terminal:exit", handler),
    openSessionFolder: (targetId: string, sessionId: string) =>
      invoke<void>(ipc, "shell:open-session-folder", targetId, sessionId),
    openPath: (params: OpenPathRequest) => invoke<void>(ipc, "shell:open-path", params),
    pathExists: (params: OpenPathRequest) => invoke<boolean>(ipc, "shell:path-exists", params)
  };
}
