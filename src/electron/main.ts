import { app, BrowserWindow, Menu, session, shell } from "electron";
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
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdownApplication().then(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
