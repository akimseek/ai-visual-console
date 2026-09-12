import { app, BrowserWindow, Menu, Tray, dialog, session, shell } from "electron";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setSessionCacheRoot, setSessionDatabasePath } from "./providers/codex/codex-store";
import { setSessionMetadataPath } from "./providers/session-metadata";
import {
  setSettingsPath
} from "./core/settings";
import {
  setVendorDatabasePath
} from "./vendors/vendor-manager";
import { stopVendorGateway } from "./gateway/vendor-gateway";
import { flushGatewayLogs, setGatewayLogPath } from "./gateway/gateway-log";
import { stopAllTerminalSessions } from "./terminal/terminal-sessions";
import { setPerformanceLogPath, writePerformanceLog } from "./core/performance";
import { resolveRuntimeStorageRoot } from "./core/application-paths";
import {
  setApplicationRuntimeRoot,
  getLogDir,
  getApplicationDataDir
} from "./core/main-helpers";
import { registerAppCommandIpc, initAppCommandIpc } from "./ipc/app-commands";
import { registerVendorIpcHandlers } from "./ipc/vendors";
import { registerGatewayIpcHandlers } from "./ipc/gateway";
import { registerSessionIpcHandlers } from "./ipc/sessions";
import { registerWorkspaceIpcHandlers } from "./ipc/workspace";
import { registerSkillIpcHandlers } from "./ipc/skills";
import { registerTerminalIpcHandlers } from './ipc/terminal';
import { registerCliIpcHandlers } from './ipc/cli';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const processStartedAt = performance.now();
// Electron 开发运行时默认会以 electron.app 作为 Windows 通知应用名；
// 显式设置显示名，确保系统通知与窗口、安装包使用同一产品名称。
app.setName("AI 可视化控制台");
if (process.platform === "win32") app.setAppUserModelId("com.akimsoft.ai.visual.console");
const applicationRuntimeRoot = resolveRuntimeStorageRoot({
  isPackaged: app.isPackaged,
  executablePath: app.getPath("exe"),
  cwd: process.cwd(),
  platform: process.platform
});
setApplicationRuntimeRoot(applicationRuntimeRoot);
const applicationUserDataPath = path.join(getApplicationDataDir(), "user-data");

// Electron 自身的缓存、Local Storage 和设置也与应用一起存放，不写入系统用户目录。
app.setPath("userData", applicationUserDataPath);

function getApplicationIconPath() {
  const iconRelativePath = process.platform === "win32" ? ["icon.ico"] : ["icon.png"];
  const iconRoot = isDev ? path.join(process.cwd(), "resources") : path.join(process.resourcesPath, "resources");
  return path.join(iconRoot, ...iconRelativePath);
}

function setupApplicationMenu() {
  Menu.setApplicationMenu(null);
}

function createWindow() {
  const createStartedAt = performance.now();
  void writePerformanceLog("window.create.start", 0);

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "AI 可视化控制台",
    icon: getApplicationIconPath(),
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  hardenWindow(window);

  window.once("ready-to-show", () => {
    void writePerformanceLog("window.ready-to-show", performance.now() - createStartedAt);
  });

  applicationWindow = window;
  window.on("close", (event) => {
    if (exitRequested) return;
    event.preventDefault();
    void requestExitConfirmation(window);
  });
  window.webContents.once("did-finish-load", () => {
    void writePerformanceLog("window.did-finish-load", performance.now() - createStartedAt);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    void writePerformanceLog(
      "window.did-fail-load",
      performance.now() - createStartedAt,
      `${errorCode}:${errorDescription}:${validatedURL}`
    );
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void writePerformanceLog(
      "window.render-process-gone",
      performance.now() - createStartedAt,
      `${details.reason}:${details.exitCode}`
    );
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    void writePerformanceLog("window.console-error", 0, `${message} (${sourceId}:${line})`);
  });

  if (isDev) {
    const loadStartedAt = performance.now();
    void writePerformanceLog("window.loadURL.start", 0);
    void window.loadURL(process.env.VITE_DEV_SERVER_URL!)
      .then(() => {
        void writePerformanceLog("window.loadURL.done", performance.now() - loadStartedAt);
      })
      .catch((error: unknown) => {
        void writePerformanceLog("window.loadURL.failed", performance.now() - loadStartedAt, String(error));
      });
  } else {
    const loadStartedAt = performance.now();
    void writePerformanceLog("window.loadFile.start", 0);
    void window.loadFile(path.join(__dirname, "../renderer/index.html"))
      .then(() => {
        void writePerformanceLog("window.loadFile.done", performance.now() - loadStartedAt);
      })
      .catch((error: unknown) => {
        void writePerformanceLog("window.loadFile.failed", performance.now() - loadStartedAt, String(error));
      });
  }
}

let applicationWindow: BrowserWindow | null = null;
let applicationTray: Tray | null = null;
let exitRequested = false;
let exitPromptOpen = false;

function restoreApplicationWindow() {
  if (!applicationWindow || applicationWindow.isDestroyed()) return;
  if (applicationWindow.isMinimized()) applicationWindow.restore();
  applicationWindow.show();
  applicationWindow.focus();
}

function ensureApplicationTray(window: BrowserWindow) {
  if (applicationTray) return;
  applicationTray = new Tray(getApplicationIconPath());
  applicationTray.setToolTip("AI 可视化控制台");
  applicationTray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: restoreApplicationWindow },
    { type: "separator" },
    { label: "退出", click: () => void requestExitConfirmation(window) }
  ]));
  applicationTray.on("click", restoreApplicationWindow);
}

async function requestExitConfirmation(window: BrowserWindow | null) {
  if (exitPromptOpen || exitRequested) return;
  exitPromptOpen = true;
  try {
    const options: Electron.MessageBoxOptions = {
      type: "question",
      title: "退出 AI 可视化控制台",
      message: "请选择关闭方式",
      detail: "最小化到托盘后，应用仍会在后台运行；直接退出会关闭所有终端和 Gateway。",
      buttons: ["最小化到托盘", "直接退出", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    };
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      if (window && !window.isDestroyed()) {
        ensureApplicationTray(window);
        window.hide();
      }
    } else if (result.response === 1) {
      exitRequested = true;
      app.quit();
    }
  } finally {
    exitPromptOpen = false;
  }
}

// 仅本应用自身页面是受信任来源：dev 走 Vite，prod 走打包后的 file://。
// 阻断一切其他导航与新窗口，外链交给系统浏览器，避免把 preload 暴露给外部内容。
function isTrustedUrl(targetUrl: string) {
  if (isDev) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    return Boolean(devServerUrl && targetUrl.startsWith(devServerUrl));
  }
  return targetUrl.startsWith("file://");
}

function hardenWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function applyContentSecurityPolicy() {
  // dev 下 Vite HMR 依赖 inline script 与 ws 连接，因此仅在打包环境强制 CSP。
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"
        ]
      }
    });
  });
}

app.whenReady().then(() => {
  const applicationDataDir = getApplicationDataDir();
  const applicationDatabasePath = path.join(applicationDataDir, "app.db");
  setupApplicationMenu();
  applyContentSecurityPolicy();
  setSessionCacheRoot(path.join(applicationDataDir, "cache"));
  setSessionDatabasePath(applicationDatabasePath);
  setSettingsPath(path.join(app.getPath("userData"), "settings.json"));
  setSessionMetadataPath(path.join(app.getPath("userData"), "session-metadata.json"));
  setVendorDatabasePath(applicationDatabasePath, path.join(applicationDataDir, "vendor-backups"));
  setPerformanceLogPath(path.join(getLogDir(), "performance.log"));
  setGatewayLogPath(getLogDir());
  void writePerformanceLog("app.ready", 0);
  void writePerformanceLog("app.whenReady", performance.now() - processStartedAt);

  // 初始化 IPC 模块依赖。
  initAppCommandIpc({ getLogDir, getVersion: () => app.getVersion() });

  // 注册各业务域的 IPC 处理器。
  registerCliIpcHandlers();

  registerAppCommandIpc();
  registerVendorIpcHandlers();
  registerGatewayIpcHandlers();
  registerSessionIpcHandlers();
  registerWorkspaceIpcHandlers();
  registerSkillIpcHandlers();
  registerTerminalIpcHandlers();

  createWindow();
});

let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;

async function shutdownApplication() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await stopAllTerminalSessions();
      await stopVendorGateway();
      await flushGatewayLogs().catch(() => undefined);
    })();
  }
  await shutdownPromise;
}

app.on("before-quit", (event) => {
  if (!exitRequested) {
    event.preventDefault();
    void requestExitConfirmation(applicationWindow);
    return;
  }
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdownApplication().then(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && exitRequested) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else restoreApplicationWindow();
});

app.on("will-quit", () => {
  applicationTray?.destroy();
  applicationTray = null;
});
