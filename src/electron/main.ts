import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  branchSession,
  clearWslCodexHome,
  deleteSession,
  deleteSessions,
  duplicateSession,
  getSession,
  getSessionMessagesPage,
  getSessionSummary,
  getSessionFolderPath,
  listCachedSessions,
  listCachedTargets,
  listProviderSummaries,
  listSessions,
  listSessionsByParent,
  listTargets,
  listTrashSessions,
  purgeSession,
  purgeSessions,
  restoreSession,
  searchSessions,
  setWslCodexHome
} from "./aiProviders";
import { setSessionCacheRoot, setSessionDatabasePath } from "./codexStore";
import { exportSessionToFile } from "./sessionExport";
import { setSessionCustomTitle, setSessionMetadataPath } from "./sessionMetadata";
import {
  deleteCompressionPrompt,
  deleteWorkspacePreset,
  listCompressionPrompts,
  listWorkspacePresets,
  saveCompressionPrompt,
  saveWorkspacePreset,
  getGatewayPort,
  setGatewayPort,
  setSettingsPath
} from "./settings";
import {
  deleteSkill,
  getSkillFolderPath,
  importSkill,
  listSkills,
  listTrashSkills,
  planSkillImport,
  purgeSkill,
  restoreSkill,
  setSkillEnabled
} from "./skills";
import type {
  ApiVendorInput,
  AiProviderId,
  AppCommand,
  CliEnvironmentRequest,
  CliInstallRequest,
  CodexTarget,
  CompressionPromptInput,
  SessionExportFormat,
  SystemTerminalKind,
  SystemTerminalStartRequest,
  WorkspacePresetInput
} from "./types";
import { checkCliEnvironment, installCli } from "./cliInstaller";
import {
  deleteApiVendor,
  enableApiVendor,
  isApiKeyEncryptionAvailable,
  listApiVendors,
  listApiVendorSummaries,
  readApiVendorConfigFiles,
  saveApiVendor,
  setVendorDatabasePath
} from "./vendorManager";
import { getVendorGatewayPort, stopVendorGateway } from "./vendorGateway";
import {
  resizeTerminalSession,
  getTerminalSessionCount,
  startSystemTerminalSession,
  startTerminalSession,
  switchTerminalVendor,
  stopAllTerminalSessions,
  stopTerminalSession,
  writeTerminalSession
} from "./terminalSessions";
import { setPerformanceLogPath, writePerformanceLog } from "./performance";
import { getAppDatabaseDiagnostics } from "./appDatabase";
import { resolveRuntimeStorageRoot } from "./applicationPaths";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const processStartedAt = performance.now();
const sessionRequestQueue = new Map<string, Promise<unknown>>();
const execFileAsync = promisify(execFile);
const applicationRuntimeRoot = resolveRuntimeStorageRoot({
  isPackaged: app.isPackaged,
  executablePath: app.getPath("exe"),
  cwd: process.cwd(),
  platform: process.platform
});
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

async function importSkillWithDialog(owner: BrowserWindow | null, target: CodexTarget) {
  try {
    if (!target?.available || !target.codexHome) {
      throw new Error("当前目标未找到 Codex 目录，无法导入 skill。");
    }

    const importKind = await chooseSkillImportKind(owner);
    if (!importKind) return;

    const options: Electron.OpenDialogOptions = {
      title: importKind === "file" ? "导入 skill Markdown 文件" : "导入 skill 目录",
      buttonLabel: "导入",
      properties: importKind === "file" ? ["openFile"] : ["openDirectory"],
      filters: importKind === "file" ? [{ name: "Markdown", extensions: ["md"] }] : undefined
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return;

    const plan = await planSkillImport(result.filePaths[0], target);
    if (plan.exists) {
      const confirmOptions: Electron.MessageBoxOptions = {
        type: "warning",
        buttons: ["覆盖", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: "覆盖已有 skill",
        message: `skill 已存在：${plan.skillName}`,
        detail: `目标目录：${plan.destinationPath}`
      };
      const confirmed = owner
        ? await dialog.showMessageBox(owner, confirmOptions)
        : await dialog.showMessageBox(confirmOptions);
      if (confirmed.response !== 0) return;
    }

    const imported = await importSkill(plan, plan.exists);
    const successOptions: Electron.MessageBoxOptions = {
      type: "info",
      title: "导入 skill",
      message: `已导入 skill：${imported.skillName}`,
      detail: `位置：${imported.destinationPath}\n\n重启 Codex 后即可使用新 skill。`
    };
    if (owner) {
      await dialog.showMessageBox(owner, successOptions);
    } else {
      await dialog.showMessageBox(successOptions);
    }
    return imported;
  } catch (error) {
    const errorOptions: Electron.MessageBoxOptions = {
      type: "error",
      title: "导入 skill 失败",
      message: error instanceof Error ? error.message : "导入 skill 失败。"
    };
    if (owner) {
      await dialog.showMessageBox(owner, errorOptions);
    } else {
      await dialog.showMessageBox(errorOptions);
    }
    throw error;
  }
}

async function chooseSkillImportKind(owner: BrowserWindow | null) {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Markdown 文件", "skill 目录", "取消"],
    defaultId: 0,
    cancelId: 2,
    title: "导入 skill",
    message: "请选择导入类型",
    detail: "Markdown 文件可以是任意文件名，导入后会写入为 SKILL.md。skill 目录需要目录内已有 SKILL.md。"
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response === 0) return "file";
  if (result.response === 1) return "directory";
  return null;
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

  if (isDev) {
    const loadStartedAt = performance.now();
    void writePerformanceLog("window.loadURL.start", 0);
    void window.loadURL(process.env.VITE_DEV_SERVER_URL!).then(() => {
      void writePerformanceLog("window.loadURL.done", performance.now() - loadStartedAt);
    });
  } else {
    const loadStartedAt = performance.now();
    void writePerformanceLog("window.loadFile.start", 0);
    void window.loadFile(path.join(__dirname, "../renderer/index.html")).then(() => {
      void writePerformanceLog("window.loadFile.done", performance.now() - loadStartedAt);
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
  void writePerformanceLog("app.ready", 0);
  void writePerformanceLog("app.whenReady", performance.now() - processStartedAt);

  ipcMain.handle("app:command", (event, command: unknown) =>
    executeAppCommand(BrowserWindow.fromWebContents(event.sender), requireAppCommand(command))
  );
  ipcMain.handle("ai:list-providers", () => listProviderSummaries());
  ipcMain.handle("cli:check-environment", (_event, request: unknown) =>
    checkCliEnvironment(requireCliEnvironmentRequest(request))
  );
  ipcMain.handle("cli:install", (_event, request: unknown) => installCli(requireCliInstallRequest(request)));
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
  ipcMain.handle("gateway:get-port", async () => ({
    configuredPort: await getGatewayPort(),
    activePort: getVendorGatewayPort()
  }));
  ipcMain.handle("gateway:set-port", async (_event, port: unknown) => {
    const checkedPort = requireGatewayPort(port);
    const configuredPort = await setGatewayPort(checkedPort);
    const activePort = getVendorGatewayPort();
    return { configuredPort, activePort, applied: activePort === 0 || activePort === configuredPort };
  });
  ipcMain.handle("codex:list-cached-targets", (_event, providerId: unknown) =>
    listCachedTargets(providerId === undefined || providerId === null || providerId === "" ? undefined : requireProviderId(providerId))
  );
  ipcMain.handle("codex:list-cached-sessions", (_event, targetId: unknown, view: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedView = requireView(view);
    return coalesceSessionRequest(`cached:${checkedTargetId}:${checkedView}`, () =>
      listCachedSessions(checkedTargetId, checkedView)
    );
  });
  ipcMain.handle("codex:list-targets", (_event, providerId: unknown) =>
    listTargets(providerId === undefined || providerId === null || providerId === "" ? undefined : requireProviderId(providerId))
  );
  ipcMain.handle("codex:list-sessions", (_event, targetId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    return coalesceSessionRequest(`list:${checkedTargetId}:active`, () => listSessions(checkedTargetId));
  });
  ipcMain.handle("codex:list-trash-sessions", (_event, targetId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    return coalesceSessionRequest(`list:${checkedTargetId}:trash`, () => listTrashSessions(checkedTargetId));
  });
  ipcMain.handle("codex:search-sessions", (_event, targetId: unknown, view: unknown, query: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedView = requireView(view);
    const checkedQuery = requireString(query, "query");
    return coalesceSessionRequest(`search:${checkedTargetId}:${checkedView}:${checkedQuery}`, () =>
      searchSessions(checkedTargetId, checkedView, checkedQuery)
    );
  });
  ipcMain.handle("codex:get-session", (_event, targetId: unknown, sessionId: unknown, refValue: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedSessionId = requireString(sessionId, "sessionId");
    const ref = requireSessionFileRef(refValue);
    return coalesceSessionRequest(`get:${checkedTargetId}:${checkedSessionId}:${ref?.filePath || ""}`, () =>
      getSession(checkedTargetId, checkedSessionId, ref)
    );
  });
  ipcMain.handle("codex:get-session-messages-page", (_event, targetId: unknown, sessionId: unknown, offset: unknown, limit: unknown) =>
    getSessionMessagesPage(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireMessagePageOffset(offset),
      Math.min(requirePositiveInteger(limit, "limit"), 500)
    )
  );
  ipcMain.handle("codex:get-session-summary", (_event, targetId: unknown, sessionId: unknown) =>
    getSessionSummary(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"))
  );
  ipcMain.handle("codex:set-session-custom-title", (_event, targetId: unknown, sessionId: unknown, title: unknown) =>
    setSessionCustomTitle(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireCustomTitle(title)
    )
  );
  ipcMain.handle("codex:list-session-children", (_event, targetId: unknown, parentSessionId: unknown) =>
    listSessionsByParent(requireString(targetId, "targetId"), requireString(parentSessionId, "parentSessionId"))
  );
  ipcMain.handle("codex:export-session", async (event, targetId: unknown, sessionId: unknown, format: unknown) => {
    const checkedFormat = requireExportFormat(format);
    const session = await getSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"));
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showSaveDialog(owner, exportDialogOptions(session.title, checkedFormat))
      : await dialog.showSaveDialog(exportDialogOptions(session.title, checkedFormat));
    if (result.canceled || !result.filePath) return null;
    return exportSessionToFile(session, checkedFormat, result.filePath);
  });
  ipcMain.handle(
    "codex:branch-session",
    (_event, targetId: unknown, sessionId: unknown, messageIndex: unknown) =>
      branchSession(
        requireString(targetId, "targetId"),
        requireString(sessionId, "sessionId"),
        requireNonNegativeInteger(messageIndex, "messageIndex")
      )
  );
  ipcMain.handle("codex:duplicate-session", (_event, targetId: unknown, sessionId: unknown, title: unknown) =>
    duplicateSession(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireCustomTitle(title)
    )
  );
  ipcMain.handle("codex:delete-session", (_event, targetId: unknown, sessionId: unknown, ref: unknown) =>
    deleteSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"), requireSessionFileRef(ref))
  );
  ipcMain.handle("codex:delete-sessions", (_event, targetId: unknown, sessions: unknown) =>
    deleteSessions(requireString(targetId, "targetId"), requireSessionMutationRefs(sessions))
  );
  ipcMain.handle("codex:restore-session", (_event, targetId: unknown, sessionId: unknown) =>
    restoreSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"))
  );
  ipcMain.handle("codex:purge-session", (_event, targetId: unknown, sessionId: unknown, ref: unknown) =>
    purgeSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"), requireSessionFileRef(ref))
  );
  ipcMain.handle("codex:purge-sessions", (_event, targetId: unknown, sessions: unknown) =>
    purgeSessions(requireString(targetId, "targetId"), requireSessionMutationRefs(sessions))
  );
  ipcMain.handle("codex:set-wsl-codex-home", (_event, distro: unknown, codexHome: unknown) =>
    setWslCodexHome(requireString(distro, "distro"), requireString(codexHome, "codexHome"))
  );
  ipcMain.handle("codex:clear-wsl-codex-home", (_event, distro: unknown) =>
    clearWslCodexHome(requireString(distro, "distro"))
  );
  ipcMain.handle("workspace:list-presets", () => listWorkspacePresets());
  ipcMain.handle("workspace:save-preset", (_event, input: unknown) =>
    saveWorkspacePreset(requireWorkspacePresetInput(input))
  );
  ipcMain.handle("workspace:delete-preset", (_event, presetId: unknown) =>
    deleteWorkspacePreset(requireString(presetId, "presetId"))
  );
  ipcMain.handle("compression-prompt:list", () => listCompressionPrompts());
  ipcMain.handle("compression-prompt:save", (_event, input: unknown) =>
    saveCompressionPrompt(requireCompressionPromptInput(input))
  );
  ipcMain.handle("compression-prompt:delete", (_event, promptId: unknown) =>
    deleteCompressionPrompt(requireString(promptId, "promptId"))
  );
  ipcMain.handle("skill:list", async (_event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return listSkills(target);
  });
  ipcMain.handle("skill:list-trash", async (_event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return listTrashSkills(target);
  });
  ipcMain.handle("skill:import", async (event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return importSkillWithDialog(BrowserWindow.fromWebContents(event.sender), target);
  });
  ipcMain.handle("skill:set-enabled", async (_event, targetId: unknown, skillName: unknown, enabled: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return setSkillEnabled(target, requireString(skillName, "skillName"), requireBoolean(enabled, "enabled"));
  });
  ipcMain.handle("skill:delete", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return deleteSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:restore", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return restoreSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:purge", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return purgeSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:open-folder", async (_event, targetId: unknown, skillName: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const target = await requireTargetById(checkedTargetId);
    const folderPath = await getSkillFolderPath(target, requireString(skillName, "skillName"));
    if (target.kind === "wsl") {
      const uncPath = `\\\\wsl.localhost\\${target.distro}${folderPath.replace(/\//g, "\\")}`;
      return shell.openPath(uncPath);
    }
    return shell.openPath(folderPath);
  });
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
  ipcMain.handle("diagnostics:export", () => exportDiagnosticsReport());
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

  createWindow();
});

app.on("window-all-closed", () => {
  stopAllTerminalSessions();
  void stopVendorGateway();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function executeAppCommand(window: BrowserWindow | null, command: AppCommand) {
  switch (command) {
    case "quit":
      app.quit();
      return;
    case "openLogDir":
      await fs.mkdir(getLogDir(), { recursive: true });
      await shell.openPath(getLogDir());
      return;
    case "about":
      if (window) {
        await dialog.showMessageBox(window, {
          type: "info",
          title: "关于 AI 可视化控制台",
          message: "AI 可视化控制台",
          detail: `版本 ${app.getVersion()}`
        });
        return;
      }
      await dialog.showMessageBox({
        type: "info",
        title: "关于 AI 可视化控制台",
        message: "AI 可视化控制台",
        detail: `版本 ${app.getVersion()}`
      });
      return;
  }
}

function getLogDir() {
  return path.join(applicationRuntimeRoot, "logs");
}

function getApplicationDataDir() {
  return path.join(applicationRuntimeRoot, "data");
}

async function exportDiagnosticsReport() {
  const dataDir = getApplicationDataDir();
  const logDir = getLogDir();
  const databasePath = path.join(dataDir, "app.db");
  const [database, databaseWal, performanceLog, appDatabase] = await Promise.all([
    fileSize(databasePath),
    fileSize(`${databasePath}-wal`),
    fileSize(path.join(logDir, "performance.log")),
    getAppDatabaseDiagnostics().catch(() => null)
  ]);
  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node
    },
    storage: {
      applicationDataDir: dataDir,
      databaseBytes: database,
      databaseWalBytes: databaseWal,
      performanceLogBytes: performanceLog
    },
    database: appDatabase,
    runtime: {
      activeTerminalSessions: getTerminalSessionCount()
    },
    privacy: "未包含 API Key、供应商配置内容、会话正文或终端输出。"
  };
  const fileName = `diagnostics-${generatedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(logDir, fileName);
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { filePath };
}

async function fileSize(filePath: string) {
  return (await fs.stat(filePath).catch(() => null))?.size || 0;
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`参数无效：${name}`);
  return value;
}

function requireCustomTitle(value: unknown) {
  if (typeof value !== "string") throw new Error("参数无效：title");
  const title = value.trim();
  if (title.length > 120) throw new Error("会话名称不能超过 120 个字符。");
  return title;
}

function coalesceSessionRequest<T>(key: string, action: () => Promise<T>): Promise<T> {
  const existing = sessionRequestQueue.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = action().finally(() => {
    if (sessionRequestQueue.get(key) === request) sessionRequestQueue.delete(key);
  });
  sessionRequestQueue.set(key, request);
  return request;
}

function requireTerminalData(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new Error("参数无效：terminal data");
  return value;
}

function requireNumber(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`参数无效：${name}`);
  return value;
}

function requireBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`参数无效：${name}`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string) {
  const numberValue = requireNumber(value, name);
  if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`参数无效：${name}`);
  return numberValue;
}

function requireNonNegativeInteger(value: unknown, name: string) {
  const numberValue = requireNumber(value, name);
  if (!Number.isInteger(numberValue) || numberValue < 0) throw new Error(`参数无效：${name}`);
  return numberValue;
}

function requireMessagePageOffset(value: unknown) {
  if (value === -1) return -1;
  return requireNonNegativeInteger(value, "offset");
}

function requireView(value: unknown) {
  if (value !== "active" && value !== "trash") throw new Error("参数无效：view");
  return value;
}

function requireProviderId(value: unknown): AiProviderId {
  if (value !== "codex" && value !== "gemini" && value !== "claude") throw new Error("参数无效：providerId");
  return value;
}

function requireGatewayPort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("网关端口必须是 0 到 65535 之间的整数。端口 0 表示自动分配。");
  }
  return port;
}

function requireAppCommand(value: unknown): AppCommand {
  const commands: AppCommand[] = [
    "quit",
    "openLogDir",
    "about"
  ];
  if (typeof value !== "string" || !commands.includes(value as AppCommand)) throw new Error("参数无效：app command");
  return value as AppCommand;
}

function requireCliInstallRequest(value: unknown): CliInstallRequest {
  if (!value || typeof value !== "object") throw new Error("参数无效：cli install");
  const request = value as Record<string, unknown>;
  return {
    providerId: requireProviderId(request.providerId),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined,
    nodeMajor: request.nodeMajor === undefined ? undefined : requirePositiveInteger(request.nodeMajor, "nodeMajor"),
    ensureNode: request.ensureNode === true
  };
}

function requireCliEnvironmentRequest(value: unknown): CliEnvironmentRequest {
  if (!value || typeof value !== "object") throw new Error("参数无效：cli environment");
  const request = value as Record<string, unknown>;
  return {
    providerId: requireProviderId(request.providerId),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined
  };
}

function requireApiVendorInput(value: unknown): ApiVendorInput {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor");
  const input = value as Record<string, unknown>;
  const configs = Array.isArray(input.configs) ? input.configs : [];
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined,
    providerId: requireProviderId(input.providerId),
    name: requireString(input.name, "name"),
    apiKey: requireString(input.apiKey, "apiKey"),
    apiBaseUrl: requireString(input.apiBaseUrl, "apiBaseUrl"),
    writeCommonConfig: input.writeCommonConfig === true,
    configs: configs.map((item) => {
      if (!item || typeof item !== "object") throw new Error("参数无效：vendor config");
      const config = item as Record<string, unknown>;
      return {
        id: typeof config.id === "string" && config.id.trim() ? config.id.trim() : undefined,
        providerId: requireProviderId(config.providerId),
        label: typeof config.label === "string" && config.label.trim() ? config.label.trim() : undefined,
        enabled: config.enabled === true,
        targetPath: requireString(config.targetPath, "targetPath"),
        content: requireString(config.content, "content")
      };
    })
  };
}

function requireApiVendorConfigReadRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor configs");
  const request = value as Record<string, unknown>;
  if (!Array.isArray(request.paths)) throw new Error("参数无效：paths");
  return {
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId.trim() : undefined,
    paths: request.paths.map((item) => requireString(item, "path"))
  };
}

function requireApiVendorEnableRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor enable");
  const request = value as Record<string, unknown>;
  return {
    vendorId: requireString(request.vendorId, "vendorId"),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId.trim() : undefined,
    terminalId: typeof request.terminalId === "string" && request.terminalId.trim() ? request.terminalId.trim() : undefined
  };
}

function requireExportFormat(value: unknown): SessionExportFormat {
  if (value !== "markdown" && value !== "json" && value !== "html") throw new Error("参数无效：format");
  return value;
}

function exportDialogOptions(title: string, format: SessionExportFormat): Electron.SaveDialogOptions {
  const extension = format === "markdown" ? "md" : format;
  return {
    title: "导出会话",
    defaultPath: `${safeFileName(title || "codex-session")}.${extension}`,
    filters: [
      format === "markdown"
        ? { name: "Markdown", extensions: ["md"] }
        : format === "json"
          ? { name: "JSON", extensions: ["json"] }
          : { name: "HTML", extensions: ["html"] }
    ]
  };
}

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 80);
  return normalized || "codex-session";
}

function requireTerminalStartParams(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：terminal params");
  const params = value as Record<string, unknown>;
  const result = {
    targetId: requireString(params.targetId, "targetId"),
    sessionId: typeof params.sessionId === "string" && params.sessionId.trim() ? params.sessionId : undefined,
    cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd : undefined,
    codexHome: typeof params.codexHome === "string" && params.codexHome.trim() ? params.codexHome.trim() : undefined,
    vendorId: typeof params.vendorId === "string" && params.vendorId.trim() ? params.vendorId.trim() : undefined,
    useCodexCwdFlag: params.useCodexCwdFlag === true,
    cliArgs: typeof params.cliArgs === "string" && params.cliArgs.trim() ? params.cliArgs.trim() : undefined,
    cols: params.cols === undefined ? undefined : requirePositiveInteger(params.cols, "cols"),
    rows: params.rows === undefined ? undefined : requirePositiveInteger(params.rows, "rows")
  };
  return result;
}

function requireSystemTerminalStartParams(value: unknown): SystemTerminalStartRequest & { cols?: number; rows?: number } {
  if (!value || typeof value !== "object") return {};
  const params = value as Record<string, unknown>;
  return {
    targetId: typeof params.targetId === "string" && params.targetId.trim() ? params.targetId.trim() : undefined,
    kind: requireSystemTerminalKind(params.kind),
    cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
    cols: params.cols === undefined ? undefined : requirePositiveInteger(params.cols, "cols"),
    rows: params.rows === undefined ? undefined : requirePositiveInteger(params.rows, "rows")
  };
}

function requireSystemTerminalKind(value: unknown): SystemTerminalKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "auto" ||
    value === "powershell" ||
    value === "cmd" ||
    value === "git-bash" ||
    value === "wsl" ||
    value === "wsl-default" ||
    value === "bash" ||
    value === "zsh" ||
    value === "fish"
  ) return value;
  throw new Error("参数无效：system terminal kind");
}

async function requireTargetById(targetId: string) {
  if (targetId.startsWith("gemini:")) {
    throw new Error("当前目标不支持 Codex Skill。");
  }
  const targets = await listTargets("codex");
  const target = targets.find((item) => item.id === targetId);
  if (target?.provider !== "codex" || !target.available || !target.codexHome) {
    throw new Error("当前目标不支持 Codex Skill。");
  }
  return target;
}

async function findTargetForVendor(targetId: string) {
  const providerId = targetId.startsWith("gemini:")
    ? "gemini"
    : targetId.startsWith("claude:")
      ? "claude"
      : "codex";
  const targets = await listTargets(providerId);
  return targets.find((item) => item.id === targetId) || null;
}

function requireWorkspacePresetInput(value: unknown): WorkspacePresetInput {
  if (!value || typeof value !== "object") throw new Error("参数无效：workspace preset");
  const input = value as Record<string, unknown>;
  return {
    name: typeof input.name === "string" ? input.name : "",
    cwd: requireString(input.cwd, "cwd"),
    targetKind: input.targetKind === "local" || input.targetKind === "wsl" ? input.targetKind : undefined,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : undefined,
    cliArgs: typeof input.cliArgs === "string" && input.cliArgs.trim() ? input.cliArgs : undefined
  };
}

function requireCompressionPromptInput(value: unknown): CompressionPromptInput {
  if (!value || typeof value !== "object") throw new Error("参数无效：compression prompt");
  const input = value as Record<string, unknown>;
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined,
    name: typeof input.name === "string" ? input.name : "",
    content: requireString(input.content, "content")
  };
}

function requireOpenPathRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：open path");
  const request = value as Record<string, unknown>;
  return {
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined,
    path: requireString(request.path, "path")
  };
}

function requireSessionFileRef(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") throw new Error("参数无效：session file ref");
  const input = value as Record<string, unknown>;
  return {
    filePath: typeof input.filePath === "string" && input.filePath.trim() ? input.filePath.trim() : undefined
  };
}

function requireSessionMutationRefs(value: unknown) {
  if (!Array.isArray(value)) throw new Error("参数无效：sessions");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("参数无效：session");
    const input = item as Record<string, unknown>;
    return {
      id: requireString(input.id, "session.id"),
      filePath: typeof input.filePath === "string" && input.filePath.trim() ? input.filePath.trim() : undefined
    };
  });
}

function toShellOpenPath(targetId: string, folderPath: string) {
  if (targetId.startsWith("wsl:") || targetId.startsWith("gemini:wsl:") || targetId.startsWith("claude:wsl:")) {
    const distro = targetId.startsWith("gemini:wsl:")
      ? targetId.slice("gemini:wsl:".length)
      : targetId.startsWith("claude:wsl:")
        ? targetId.slice("claude:wsl:".length)
        : targetId.slice("wsl:".length);
    return `\\\\wsl.localhost\\${distro}${folderPath.replace(/\//g, "\\")}`;
  }
  return folderPath;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsForTarget(targetId: string, folderPath: string) {
  if (!folderPath) return false;
  if (targetId.startsWith("wsl:") || targetId.startsWith("gemini:wsl:") || targetId.startsWith("claude:wsl:")) {
    const distro = targetId.startsWith("gemini:wsl:")
      ? targetId.slice("gemini:wsl:".length)
      : targetId.startsWith("claude:wsl:")
        ? targetId.slice("claude:wsl:".length)
        : targetId.slice("wsl:".length);
    if (!distro) return false;
    try {
      await execFileAsync("wsl.exe", ["-d", distro, "--", "bash", "-lc", `test -e ${shellQuote(folderPath)}`]);
      return true;
    } catch {
      return false;
    }
  }
  return pathExists(folderPath);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
