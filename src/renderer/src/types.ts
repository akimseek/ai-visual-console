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
  AiTarget,
  AppCommand,
  CliEnvironmentRequest,
  CliEnvironmentStatus,
  CliInstallRequest,
  CliInstallResult,
  GatewayPortStatus,
  GatewayPortUpdateResult,
  InstalledSkill,
  OpenPathRequest,
  SessionExportFormat,
  SessionExportResult,
  SessionMetadata,
  SessionMessagePage,
  SystemTerminalStartRequest,
  TerminalStartParams,
  VendorModel,
  WorkspacePreset,
  WorkspacePresetInput
} from "../../shared/types";

export type {
  SystemTerminalKind,
  AiMessage,
  AiProviderId,
  AiProviderCapabilities,
  AiProviderSummary,
  ApiVendor,
  ApiVendorConfigTemplate,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorInput,
  CompressionPrompt,
  CompressionPromptInput,
  CliEnvironmentRequest,
  CliEnvironmentStatus,
  CliInstallRequest,
  CliInstallResult,
  GatewayPortStatus,
  GatewayPortUpdateResult,
  AiSession,
  AiSessionFile,
  AiTarget,
  AppCommand,
  CodexMessage,
  CodexSession,
  CodexTarget,
  InstalledSkill,
  SessionUsage,
  SessionBranchMetadata,
  SessionMetadata,
  SessionMessagePage,
  SessionExportFormat,
  SessionExportResult,
  OpenPathRequest,
  SystemTerminalStartRequest,
  TerminalStartParams,
  TokenUsage,
  VendorModel,
  WorkspacePreset,
  WorkspacePresetInput
} from "../../shared/types";

export type CodexConsoleApi = {
  appCommand: (command: AppCommand) => Promise<void>;
  listProviders: () => Promise<AiProviderSummary[]>;
  checkCliEnvironment: (request: CliEnvironmentRequest) => Promise<CliEnvironmentStatus>;
  installCli: (request: CliInstallRequest) => Promise<CliInstallResult>;
  getGatewayPort: () => Promise<GatewayPortStatus>;
  setGatewayPort: (port: number) => Promise<GatewayPortUpdateResult>;
  listApiVendors: (targetId?: string) => Promise<ApiVendor[]>;
  saveApiVendor: (input: ApiVendorInput) => Promise<ApiVendor>;
  isApiKeyEncryptionAvailable: () => Promise<boolean>;
  deleteApiVendor: (vendorId: string) => Promise<{ deleted: boolean }>;
  readApiVendorConfigs: (request: ApiVendorConfigReadRequest) => Promise<ApiVendorConfigReadResult>;
  enableApiVendor: (request: ApiVendorEnableRequest) => Promise<ApiVendorEnableResult>;
  switchVendorRoute: (terminalId: string, vendorId: string) => Promise<{
    switched: number;
    reason?: "terminal-not-found" | "gateway-not-active" | "route-not-found" | "provider-mismatch";
  }>;
  listVendorModels: (vendorId: string) => Promise<VendorModel[]>;
  listCompressionPrompts: () => Promise<CompressionPrompt[]>;
  saveCompressionPrompt: (input: CompressionPromptInput) => Promise<CompressionPrompt>;
  deleteCompressionPrompt: (promptId: string) => Promise<{ deleted: boolean }>;
  listCachedTargets: (providerId?: AiProviderId) => Promise<AiTarget[]>;
  listCachedSessions: (targetId: string, view: "active" | "trash") => Promise<AiSession[]>;
  listTargets: (providerId?: AiProviderId) => Promise<AiTarget[]>;
  listSessions: (targetId: string) => Promise<AiSession[]>;
  listTrashSessions: (targetId: string) => Promise<AiSession[]>;
  searchSessions: (targetId: string, view: "active" | "trash", query: string) => Promise<AiSession[]>;
  getSession: (targetId: string, sessionId: string, ref?: { filePath?: string }) => Promise<AiSession>;
  getSessionMessagesPage: (targetId: string, sessionId: string, offset: number, limit: number) => Promise<SessionMessagePage>;
  getSessionSummary: (targetId: string, sessionId: string) => Promise<AiSession>;
  setSessionCustomTitle: (targetId: string, sessionId: string, title: string) => Promise<SessionMetadata>;
  listSessionChildren: (targetId: string, parentSessionId: string) => Promise<AiSession[]>;
  exportSession: (targetId: string, sessionId: string, format: SessionExportFormat) => Promise<SessionExportResult | null>;
  branchSession: (params: {
    targetId: string;
    sessionId: string;
    messageIndex: number;
  }) => Promise<AiSession>;
  duplicateSession: (targetId: string, sessionId: string, title: string) => Promise<AiSession>;
  deleteSession: (targetId: string, sessionId: string, ref?: { filePath?: string }) => Promise<{ movedTo: string }>;
  deleteSessions: (targetId: string, sessions: Array<{ id: string; filePath?: string }>) => Promise<{ processed: Array<{ id: string; filePath?: string }> }>;
  restoreSession: (targetId: string, sessionId: string) => Promise<{ restoredTo: string }>;
  purgeSession: (targetId: string, sessionId: string, ref?: { filePath?: string }) => Promise<{ deleted: string }>;
  purgeSessions: (targetId: string, sessions: Array<{ id: string; filePath?: string }>) => Promise<{ processed: Array<{ id: string; filePath?: string }> }>;
  setWslCodexHome: (distro: string, codexHome: string) => Promise<{ saved: boolean }>;
  clearWslCodexHome: (distro: string) => Promise<{ cleared: boolean }>;
  listWorkspacePresets: () => Promise<WorkspacePreset[]>;
  saveWorkspacePreset: (input: WorkspacePresetInput) => Promise<WorkspacePreset>;
  deleteWorkspacePreset: (presetId: string) => Promise<{ deleted: boolean }>;
  listSkills: (targetId: string) => Promise<InstalledSkill[]>;
  listTrashSkills: (targetId: string) => Promise<InstalledSkill[]>;
  importSkill: (targetId: string) => Promise<{ skillName: string; destinationPath: string } | undefined>;
  setSkillEnabled: (targetId: string, skillName: string, enabled: boolean) => Promise<{ renamedTo: string }>;
  deleteSkill: (targetId: string, skillName: string) => Promise<{ movedTo: string }>;
  restoreSkill: (targetId: string, skillName: string) => Promise<{ restoredTo: string }>;
  purgeSkill: (targetId: string, skillName: string) => Promise<{ deleted: string }>;
  openSkillFolder: (targetId: string, skillName: string) => Promise<void>;
  startTerminal: (params: TerminalStartParams & { cols?: number; rows?: number }) => Promise<{ terminalId: string }>;
  startSystemTerminal: (params: SystemTerminalStartRequest) => Promise<{ terminalId: string }>;
  chooseDirectory: () => Promise<{ filePath?: string }>;
  writeTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  stopTerminal: (terminalId: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  readText: () => Promise<string>;
  logPerformance: (label: string, durationMs: number, status?: string) => Promise<void>;
  exportDiagnostics: () => Promise<{ filePath: string }>;
  onTerminalData: (handler: (terminalId: string, data: string) => void) => () => void;
  onTerminalExit: (handler: (terminalId: string, exitCode: number) => void) => () => void;
  openSessionFolder: (targetId: string, sessionId: string) => Promise<void>;
  openPath: (params: OpenPathRequest) => Promise<void>;
  pathExists: (params: OpenPathRequest) => Promise<boolean>;
};
