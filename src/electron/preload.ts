import { contextBridge, ipcRenderer } from "electron";
import type {
  AiProviderId,
  AiProviderSummary,
  ApiVendor,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorInput,
  CompressionPrompt,
  CompressionPromptInput,
  AiSession,
  SessionMessagePage,
  AiTarget,
  AppCommand,
  CliEnvironmentRequest,
  CliEnvironmentStatus,
  CliInstallRequest,
  CliInstallResult,
  GatewayPortStatus,
  GatewayPortUpdateResult,
  InstalledSkill,
  SessionBranchParams,
  SessionExportFormat,
  SessionExportResult,
  OpenPathRequest,
  SessionMutationRef,
  SessionFileRef,
  SystemTerminalStartRequest,
  TerminalStartRequest,
  WorkspacePreset,
  WorkspacePresetInput
} from "./types";

const api = {
  appCommand: (command: AppCommand) => ipcRenderer.invoke("app:command", command) as Promise<void>,
  listProviders: () => ipcRenderer.invoke("ai:list-providers") as Promise<AiProviderSummary[]>,
  checkCliEnvironment: (request: CliEnvironmentRequest) =>
    ipcRenderer.invoke("cli:check-environment", request) as Promise<CliEnvironmentStatus>,
  installCli: (request: CliInstallRequest) =>
    ipcRenderer.invoke("cli:install", request) as Promise<CliInstallResult>,
  getGatewayPort: () => ipcRenderer.invoke("gateway:get-port") as Promise<GatewayPortStatus>,
  setGatewayPort: (port: number) => ipcRenderer.invoke("gateway:set-port", port) as Promise<GatewayPortUpdateResult>,
  listApiVendors: (targetId?: string) => ipcRenderer.invoke("vendor:list", targetId) as Promise<ApiVendor[]>,
  saveApiVendor: (input: ApiVendorInput) => ipcRenderer.invoke("vendor:save", input) as Promise<ApiVendor>,
  isApiKeyEncryptionAvailable: () =>
    ipcRenderer.invoke("vendor:encryption-available") as Promise<boolean>,
  deleteApiVendor: (vendorId: string) => ipcRenderer.invoke("vendor:delete", vendorId) as Promise<{ deleted: boolean }>,
  readApiVendorConfigs: (request: ApiVendorConfigReadRequest) =>
    ipcRenderer.invoke("vendor:read-configs", request) as Promise<ApiVendorConfigReadResult>,
  enableApiVendor: (request: ApiVendorEnableRequest) =>
    ipcRenderer.invoke("vendor:enable", request) as Promise<ApiVendorEnableResult>,
  switchVendorRoute: (terminalId: string, vendorId: string) =>
    ipcRenderer.invoke("vendor:route-switch", terminalId, vendorId) as Promise<{
      switched: number;
      reason?: "terminal-not-found" | "gateway-not-active" | "route-not-found" | "provider-mismatch";
    }>,
  listCompressionPrompts: () => ipcRenderer.invoke("compression-prompt:list") as Promise<CompressionPrompt[]>,
  saveCompressionPrompt: (input: CompressionPromptInput) =>
    ipcRenderer.invoke("compression-prompt:save", input) as Promise<CompressionPrompt>,
  deleteCompressionPrompt: (promptId: string) =>
    ipcRenderer.invoke("compression-prompt:delete", promptId) as Promise<{ deleted: boolean }>,
  listCachedTargets: (providerId?: AiProviderId) =>
    ipcRenderer.invoke("codex:list-cached-targets", providerId) as Promise<AiTarget[]>,
  listCachedSessions: (targetId: string, view: "active" | "trash") =>
    ipcRenderer.invoke("codex:list-cached-sessions", targetId, view) as Promise<AiSession[]>,
  listTargets: (providerId?: AiProviderId) =>
    ipcRenderer.invoke("codex:list-targets", providerId) as Promise<AiTarget[]>,
  listSessions: (targetId: string) =>
    ipcRenderer.invoke("codex:list-sessions", targetId) as Promise<AiSession[]>,
  listTrashSessions: (targetId: string) =>
    ipcRenderer.invoke("codex:list-trash-sessions", targetId) as Promise<AiSession[]>,
  searchSessions: (targetId: string, view: "active" | "trash", query: string) =>
    ipcRenderer.invoke("codex:search-sessions", targetId, view, query) as Promise<AiSession[]>,
  getSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
    ipcRenderer.invoke("codex:get-session", targetId, sessionId, ref) as Promise<AiSession>,
  getSessionMessagesPage: (targetId: string, sessionId: string, offset: number, limit: number) =>
    ipcRenderer.invoke("codex:get-session-messages-page", targetId, sessionId, offset, limit) as Promise<SessionMessagePage>,
  getSessionSummary: (targetId: string, sessionId: string) =>
    ipcRenderer.invoke("codex:get-session-summary", targetId, sessionId) as Promise<AiSession>,
  setSessionCustomTitle: (targetId: string, sessionId: string, title: string) =>
    ipcRenderer.invoke("codex:set-session-custom-title", targetId, sessionId, title) as Promise<import("./types").SessionMetadata>,
  listSessionChildren: (targetId: string, parentSessionId: string) =>
    ipcRenderer.invoke("codex:list-session-children", targetId, parentSessionId) as Promise<AiSession[]>,
  exportSession: (targetId: string, sessionId: string, format: SessionExportFormat) =>
    ipcRenderer.invoke("codex:export-session", targetId, sessionId, format) as Promise<SessionExportResult | null>,
  branchSession: (params: SessionBranchParams) =>
    ipcRenderer.invoke(
      "codex:branch-session",
      params.targetId,
      params.sessionId,
      params.messageIndex
    ) as Promise<AiSession>,
  duplicateSession: (targetId: string, sessionId: string, title: string) =>
    ipcRenderer.invoke("codex:duplicate-session", targetId, sessionId, title) as Promise<AiSession>,
  deleteSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
    ipcRenderer.invoke("codex:delete-session", targetId, sessionId, ref) as Promise<{ movedTo: string }>,
  deleteSessions: (targetId: string, sessions: SessionMutationRef[]) =>
    ipcRenderer.invoke("codex:delete-sessions", targetId, sessions) as Promise<{ processed: SessionMutationRef[] }>,
  restoreSession: (targetId: string, sessionId: string) =>
    ipcRenderer.invoke("codex:restore-session", targetId, sessionId) as Promise<{ restoredTo: string }>,
  purgeSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
    ipcRenderer.invoke("codex:purge-session", targetId, sessionId, ref) as Promise<{ deleted: string }>,
  purgeSessions: (targetId: string, sessions: SessionMutationRef[]) =>
    ipcRenderer.invoke("codex:purge-sessions", targetId, sessions) as Promise<{ processed: SessionMutationRef[] }>,
  setWslCodexHome: (distro: string, codexHome: string) =>
    ipcRenderer.invoke("codex:set-wsl-codex-home", distro, codexHome) as Promise<{ saved: boolean }>,
  clearWslCodexHome: (distro: string) =>
    ipcRenderer.invoke("codex:clear-wsl-codex-home", distro) as Promise<{ cleared: boolean }>,
  listWorkspacePresets: () => ipcRenderer.invoke("workspace:list-presets") as Promise<WorkspacePreset[]>,
  saveWorkspacePreset: (input: WorkspacePresetInput) =>
    ipcRenderer.invoke("workspace:save-preset", input) as Promise<WorkspacePreset>,
  deleteWorkspacePreset: (presetId: string) =>
    ipcRenderer.invoke("workspace:delete-preset", presetId) as Promise<{ deleted: boolean }>,
  listSkills: (targetId: string) => ipcRenderer.invoke("skill:list", targetId) as Promise<InstalledSkill[]>,
  listTrashSkills: (targetId: string) =>
    ipcRenderer.invoke("skill:list-trash", targetId) as Promise<InstalledSkill[]>,
  importSkill: (targetId: string) =>
    ipcRenderer.invoke("skill:import", targetId) as Promise<{ skillName: string; destinationPath: string } | undefined>,
  setSkillEnabled: (targetId: string, skillName: string, enabled: boolean) =>
    ipcRenderer.invoke("skill:set-enabled", targetId, skillName, enabled) as Promise<{ renamedTo: string }>,
  deleteSkill: (targetId: string, skillName: string) =>
    ipcRenderer.invoke("skill:delete", targetId, skillName) as Promise<{ movedTo: string }>,
  restoreSkill: (targetId: string, skillName: string) =>
    ipcRenderer.invoke("skill:restore", targetId, skillName) as Promise<{ restoredTo: string }>,
  purgeSkill: (targetId: string, skillName: string) =>
    ipcRenderer.invoke("skill:purge", targetId, skillName) as Promise<{ deleted: string }>,
  openSkillFolder: (targetId: string, skillName: string) =>
    ipcRenderer.invoke("skill:open-folder", targetId, skillName) as Promise<void>,
  startTerminal: (params: TerminalStartRequest) =>
    ipcRenderer.invoke("terminal:start", params) as Promise<{ terminalId: string }>,
  startSystemTerminal: (params: SystemTerminalStartRequest) =>
    ipcRenderer.invoke("terminal:start-system", params) as Promise<{ terminalId: string }>,
  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-directory") as Promise<{ filePath?: string }>,
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.invoke("terminal:write", terminalId, data) as Promise<void>,
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:resize", terminalId, cols, rows) as Promise<void>,
  stopTerminal: (terminalId: string) => ipcRenderer.invoke("terminal:stop", terminalId) as Promise<void>,
  copyText: (text: string) => ipcRenderer.invoke("clipboard:copy-text", text) as Promise<void>,
  readText: () => ipcRenderer.invoke("clipboard:read-text") as Promise<string>,
  logPerformance: (label: string, durationMs: number, status?: string) =>
    ipcRenderer.invoke("performance:log", label, durationMs, status) as Promise<void>,
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export") as Promise<{ filePath: string }>,
  onTerminalData: (handler: (terminalId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, terminalId: string, data: string) => handler(terminalId, data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.off("terminal:data", listener);
  },
  onTerminalExit: (handler: (terminalId: string, exitCode: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, terminalId: string, exitCode: number) =>
      handler(terminalId, exitCode);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.off("terminal:exit", listener);
  },
  onOpenSessionSettings: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("menu:open-session-settings", listener);
    return () => ipcRenderer.off("menu:open-session-settings", listener);
  },
  onOpenSkillManager: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("menu:open-skill-manager", listener);
    return () => ipcRenderer.off("menu:open-skill-manager", listener);
  },
  onOpenCliInstaller: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("menu:open-cli-installer", listener);
    return () => ipcRenderer.off("menu:open-cli-installer", listener);
  },
  openSessionFolder: (targetId: string, sessionId: string) =>
    ipcRenderer.invoke("shell:open-session-folder", targetId, sessionId) as Promise<void>,
  openPath: (params: OpenPathRequest) =>
    ipcRenderer.invoke("shell:open-path", params) as Promise<void>,
  pathExists: (params: OpenPathRequest) =>
    ipcRenderer.invoke("shell:path-exists", params) as Promise<boolean>
};

contextBridge.exposeInMainWorld("codexConsole", api);

export type CodexConsoleApi = typeof api;
