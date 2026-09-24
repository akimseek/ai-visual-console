import { BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { AppCommand } from "../types";
import { requireAppCommand } from "./validation";

// 这些依赖由 main.ts 在应用就绪后注入，避免 IPC 模块自行读取应用生命周期状态。
let getApplicationLogDir: () => string;
let getAppVersion: () => string;
let requestExit: (window: BrowserWindow | null) => void;
let resolveExit: (window: BrowserWindow | null, choice: "minimize" | "quit" | "cancel") => void;

export function initAppCommandIpc(helpers: {
  getLogDir: () => string;
  getVersion: () => string;
  requestExit: (window: BrowserWindow | null) => void;
  resolveExit: (window: BrowserWindow | null, choice: "minimize" | "quit" | "cancel") => void;
}) {
  getApplicationLogDir = helpers.getLogDir;
  getAppVersion = helpers.getVersion;
  requestExit = helpers.requestExit;
  resolveExit = helpers.resolveExit;
}

export function registerAppCommandIpc() {
  ipcMain.handle("app:command", (event, command: unknown) =>
    executeAppCommand(BrowserWindow.fromWebContents(event.sender), requireAppCommand(command))
  );
  ipcMain.handle("app:get-version", () => getAppVersion());
  ipcMain.handle("app:exit-choice", (event, choice: unknown) => {
    if (choice !== "minimize" && choice !== "quit" && choice !== "cancel") throw new Error("退出方式无效。");
    resolveExit(BrowserWindow.fromWebContents(event.sender), choice);
  });
}

async function executeAppCommand(window: BrowserWindow | null, command: AppCommand) {
  switch (command) {
    case "quit":
      requestExit(window);
      return;
    case "openLogDir":
      await fs.mkdir(getApplicationLogDir(), { recursive: true });
      await shell.openPath(getApplicationLogDir());
      return;
  }
}
