import type { IpcRenderer } from "electron";
import type {
  AiProviderId,
  AiProviderSummary,
  AiTarget,
  AppCommand,
  CliEnvironmentRequest,
  CliEnvironmentStatus,
  CliInstallRequest,
  CliInstallResult,
  VendorModel,
  WorkspacePreset,
  WorkspacePresetInput
} from "../types";
import { invoke, subscribe } from "./ipc-bridge";

// 应用级命令、版本信息、CLI 环境和工作区预设 API。
export function createAppApi(ipc: IpcRenderer) {
  return {
    appCommand: (command: AppCommand) => invoke<void>(ipc, "app:command", command),
    getAppVersion: () => invoke<string>(ipc, "app:get-version"),
    chooseExitAction: (choice: "minimize" | "quit" | "cancel") => invoke<void>(ipc, "app:exit-choice", choice),
    onExitConfirmationRequested: (handler: () => void) => subscribe(ipc, "app:request-exit", handler),
    listProviders: () => invoke<AiProviderSummary[]>(ipc, "ai:list-providers"),
    checkCliEnvironment: (request: CliEnvironmentRequest) =>
      invoke<CliEnvironmentStatus>(ipc, "cli:check-environment", request),
    installCli: (request: CliInstallRequest) => invoke<CliInstallResult>(ipc, "cli:install", request),
    listModels: (targetId: string) => invoke<VendorModel[]>(ipc, "models:list", targetId),
    listCachedTargets: (providerId?: AiProviderId) =>
      invoke<AiTarget[]>(ipc, "codex:list-cached-targets", providerId),
    listTargets: (providerId?: AiProviderId) => invoke<AiTarget[]>(ipc, "codex:list-targets", providerId),
    listWorkspacePresets: () => invoke<WorkspacePreset[]>(ipc, "workspace:list-presets"),
    saveWorkspacePreset: (input: WorkspacePresetInput) =>
      invoke<WorkspacePreset>(ipc, "workspace:save-preset", input),
    deleteWorkspacePreset: (presetId: string) =>
      invoke<{ deleted: boolean }>(ipc, "workspace:delete-preset", presetId),
    logPerformance: (label: string, durationMs: number, status?: string) =>
      invoke<void>(ipc, "performance:log", label, durationMs, status)
  };
}
