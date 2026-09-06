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
  CompressionPrompt,
  CompressionPromptInput,
  VendorModel,
  WorkspacePreset,
  WorkspacePresetInput
} from "../types";
import { invoke } from "./ipc-bridge";

// 应用级命令、CLI 环境、工作区预设和压缩提示 API。
export function createAppApi(ipc: IpcRenderer) {
  return {
    appCommand: (command: AppCommand) => invoke<void>(ipc, "app:command", command),
    listProviders: () => invoke<AiProviderSummary[]>(ipc, "ai:list-providers"),
    checkCliEnvironment: (request: CliEnvironmentRequest) =>
      invoke<CliEnvironmentStatus>(ipc, "cli:check-environment", request),
    installCli: (request: CliInstallRequest) => invoke<CliInstallResult>(ipc, "cli:install", request),
    listCompressionPrompts: () => invoke<CompressionPrompt[]>(ipc, "compression-prompt:list"),
    saveCompressionPrompt: (input: CompressionPromptInput) =>
      invoke<CompressionPrompt>(ipc, "compression-prompt:save", input),
    deleteCompressionPrompt: (promptId: string) =>
      invoke<{ deleted: boolean }>(ipc, "compression-prompt:delete", promptId),
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
