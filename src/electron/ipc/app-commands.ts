import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { AppCommand } from "../types";
import { requireAppCommand } from "./validation";

// 这些依赖由 main.ts 在应用就绪后注入，避免 IPC 模块自行读取应用生命周期状态。
let getApplicationLogDir: () => string;
let getAppVersion: () => string;

export function initAppCommandIpc(helpers: { getLogDir: () => string; getVersion: () => string }) {
  getApplicationLogDir = helpers.getLogDir;
  getAppVersion = helpers.getVersion;
}

export function registerAppCommandIpc() {
  ipcMain.handle("app:command", (event, command: unknown) =>
    executeAppCommand(BrowserWindow.fromWebContents(event.sender), requireAppCommand(command))
  );
}

async function executeAppCommand(window: BrowserWindow | null, command: AppCommand) {
  switch (command) {
    case "quit":
      app.quit();
      return;
    case "openLogDir":
      await fs.mkdir(getApplicationLogDir(), { recursive: true });
      await shell.openPath(getApplicationLogDir());
      return;
    case "about":
      if (window) {
        await dialog.showMessageBox(window, {
          type: "info",
          title: "关于 AI 可视化控制台",
          message: "AI 可视化控制台",
          detail: `版本 ${getAppVersion()}`
        });
        return;
      }
      await dialog.showMessageBox({
        type: "info",
        title: "关于 AI 可视化控制台",
        message: "AI 可视化控制台",
        detail: `版本 ${getAppVersion()}`
      });
      return;
  }
}
