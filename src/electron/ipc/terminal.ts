import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { getSessionFolderPath } from "../providers/ai-providers";
import { pathExists } from "../core/fs-utils";
import { wslPathExists } from "../core/wsl";
import { getWslDistroFromTargetId } from "../../shared/target-ids";
import { writePerformanceLog } from "../core/performance";
import {
  resizeTerminalSession,
  startSystemTerminalSession,
  startTerminalSession,
  stopTerminalSession,
  writeTerminalSession
} from "../terminal/terminal-sessions";
import {
  requireString,
  requireNumber,
  requirePositiveInteger,
  requireTerminalData,
  requireTerminalStartParams,
  requireSystemTerminalStartParams,
  requireOpenPathRequest
} from "./validation";

export function registerTerminalIpcHandlers() {
  ipcMain.handle("terminal:start", (event, params: unknown) =>
    startTerminalSession(BrowserWindow.fromWebContents(event.sender)!, requireTerminalStartParams(params))
  );
  ipcMain.handle("terminal:start-system", (event, params: unknown) =>
    startSystemTerminalSession(BrowserWindow.fromWebContents(event.sender)!, requireSystemTerminalStartParams(params))
  );
  ipcMain.handle("dialog:choose-directory", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "设置工作目录",
      properties: ["openDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return { filePath: result.canceled ? undefined : result.filePaths[0] };
  });
  ipcMain.handle("terminal:write", (_event, terminalId: unknown, data: unknown) =>
    writeTerminalSession(requireString(terminalId, "terminalId"), requireTerminalData(data))
  );
  ipcMain.handle("terminal:resize", (_event, terminalId: unknown, cols: unknown, rows: unknown) =>
    resizeTerminalSession(
      requireString(terminalId, "terminalId"),
      requirePositiveInteger(cols, "cols"),
      requirePositiveInteger(rows, "rows")
    )
  );
  ipcMain.handle("terminal:stop", (_event, terminalId: unknown) => stopTerminalSession(requireString(terminalId, "terminalId")));
  ipcMain.handle("clipboard:copy-text", (_event, text: unknown) => {
    clipboard.writeText(requireString(text, "text"));
  });
  ipcMain.handle("clipboard:read-text", () => clipboard.readText());
  ipcMain.handle("performance:log", (_event, label: unknown, durationMs: unknown, status?: unknown) =>
    writePerformanceLog(
      requireString(label, "label"),
      requireNumber(durationMs, "durationMs"),
      typeof status === "string" ? status : undefined
    )
  );
  ipcMain.handle("shell:open-session-folder", async (_event, targetId: unknown, sessionId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const folderPath = await getSessionFolderPath(checkedTargetId, requireString(sessionId, "sessionId"));
    return shell.openPath(toShellOpenPath(checkedTargetId, folderPath));
  });
  ipcMain.handle("shell:open-path", async (_event, params: unknown) => {
    const checked = requireOpenPathRequest(params);
    return shell.openPath(toShellOpenPath(checked.targetId || "", checked.path));
  });
  ipcMain.handle("shell:path-exists", async (_event, params: unknown) => {
    const checked = requireOpenPathRequest(params);
    return pathExistsForTarget(checked.targetId || "", checked.path);
  });
}

function toShellOpenPath(targetId: string, folderPath: string) {
  const distro = getWslDistroFromTargetId(targetId);
  if (distro) return `\\\\wsl.localhost\\${distro}${folderPath.replace(/\//g, "\\")}`;
  return folderPath;
}

async function pathExistsForTarget(targetId: string, folderPath: string) {
  if (!folderPath) return false;
  const distro = getWslDistroFromTargetId(targetId);
  if (distro) return wslPathExists(distro, folderPath);
  return pathExists(folderPath);
}

