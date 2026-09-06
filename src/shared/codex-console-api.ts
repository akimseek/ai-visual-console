import type {
  AiProviderId,
  AiProviderSummary,
  AiSession,
  AiTarget,
  ApiVendor,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorEnabledResult,
  ApiVendorInput,
  AppCommand,
  CliEnvironmentRequest,
  CliEnvironmentStatus,
  CliInstallRequest,
  CliInstallResult,
  CompressionPrompt,
  CompressionPromptInput,
  GatewayFailureDiagnosticsPage,
  GatewayFailureOutcomeFilter,
  GatewayLogCleanupFilter,
  GatewayLogCleanupPage,
  GatewayLogCleanupResult,
  GatewayLogCleanupSelection,
  GatewayPortStatus,
  GatewayPortUpdateResult,
  GatewayRecentFailure,
  GatewayRequestRecordedEvent,
  GatewayUsageSummary,
  GatewayUsageReport,
  GatewayVendorHealth,
  GatewayVendorSwitchEvent,
  InstalledSkill,
  OpenPathRequest,
  SessionBatchMutationResult,
  SessionBranchParams,
  SessionExportFormat,
  SessionExportResult,
  SessionFileRef,
  SessionMessagePage,
  SessionMetadata,
  SessionMutationRef,
  SystemTerminalStartRequest,
  TerminalStartRequest,
  TerminalStartResult,
  VendorBalanceBatchResult,
  VendorBalanceRefreshResult,
  VendorModel,
  VendorRouteSwitchResult,
  WorkspacePreset,
  WorkspacePresetInput
} from "./types";

// 渲染进程与 preload 共用的 API 契约；这里只描述公开能力，不包含 Electron 运行时类型。
export type CodexConsoleApi = {
  appCommand: (command: AppCommand) => Promise<void>;
  listProviders: () => Promise<AiProviderSummary[]>;
  checkCliEnvironment: (request: CliEnvironmentRequest) => Promise<CliEnvironmentStatus>;
  installCli: (request: CliInstallRequest) => Promise<CliInstallResult>;
  getGatewayPort: () => Promise<GatewayPortStatus>;
  setGatewayPort: (
    port: number,
    failureThreshold: number,
    circuitFailureThreshold: number,
    circuitDurationSeconds: number
  ) => Promise<GatewayPortUpdateResult>;
  listApiVendors: (targetId?: string) => Promise<ApiVendor[]>;
  saveApiVendor: (input: ApiVendorInput) => Promise<ApiVendor>;
  deleteApiVendor: (vendorId: string) => Promise<{ deleted: boolean }>;
  readApiVendorConfigs: (request: ApiVendorConfigReadRequest) => Promise<ApiVendorConfigReadResult>;
  enableApiVendor: (request: ApiVendorEnableRequest) => Promise<ApiVendorEnableResult>;
  setApiVendorEnabled: (vendorId: string, enabled: boolean) => Promise<ApiVendorEnabledResult>;
  switchVendorRoute: (terminalId: string, vendorId: string) => Promise<VendorRouteSwitchResult>;
  listVendorModels: (vendorId: string) => Promise<VendorModel[]>;
  refreshVendorBalance: (vendorId: string) => Promise<VendorBalanceRefreshResult>;
  refreshVendorBalances: () => Promise<VendorBalanceBatchResult>;
  getGatewayVendorHealth: () => Promise<GatewayVendorHealth[]>;
  resetGatewayVendorHealth: (vendorId?: string) => Promise<void>;
  queryGatewayLogs: (filter: GatewayLogCleanupFilter, page?: number, pageSize?: number) => Promise<GatewayLogCleanupPage>;
  deleteGatewayLogEntries: (selections: GatewayLogCleanupSelection[]) => Promise<GatewayLogCleanupResult>;
  getGatewayUsageSummary: (periodStart: string, periodEnd: string) => Promise<GatewayUsageSummary>;
  getGatewayUsageReport: (periodStart: string, periodEnd: string) => Promise<GatewayUsageReport>;
  getGatewayRecentFailures: () => Promise<GatewayRecentFailure[]>;
  getGatewayFailureDiagnostics: (
    page?: number,
    pageSize?: number,
    vendorId?: string,
    outcome?: GatewayFailureOutcomeFilter,
    periodStart?: string,
    periodEnd?: string
  ) => Promise<GatewayFailureDiagnosticsPage>;
  listModels: (targetId: string) => Promise<VendorModel[]>;
  listCompressionPrompts: () => Promise<CompressionPrompt[]>;
  saveCompressionPrompt: (input: CompressionPromptInput) => Promise<CompressionPrompt>;
  deleteCompressionPrompt: (promptId: string) => Promise<{ deleted: boolean }>;
  listCachedTargets: (providerId?: AiProviderId) => Promise<AiTarget[]>;
  listCachedSessions: (targetId: string, view: "active" | "trash") => Promise<AiSession[]>;
  listTargets: (providerId?: AiProviderId) => Promise<AiTarget[]>;
  listSessions: (targetId: string) => Promise<AiSession[]>;
  listTrashSessions: (targetId: string) => Promise<AiSession[]>;
  searchSessions: (targetId: string, view: "active" | "trash", query: string) => Promise<AiSession[]>;
  getSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<AiSession>;
  getSessionMessagesPage: (targetId: string, sessionId: string, offset: number, limit: number) => Promise<SessionMessagePage>;
  getSessionSummary: (targetId: string, sessionId: string) => Promise<AiSession>;
  setSessionCustomTitle: (targetId: string, sessionId: string, title: string) => Promise<SessionMetadata>;
  listSessionChildren: (targetId: string, parentSessionId: string) => Promise<AiSession[]>;
  exportSession: (targetId: string, sessionId: string, format: SessionExportFormat) => Promise<SessionExportResult | null>;
  branchSession: (params: SessionBranchParams) => Promise<AiSession>;
  duplicateSession: (targetId: string, sessionId: string, title: string) => Promise<AiSession>;
  deleteSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<{ movedTo: string }>;
  deleteSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
  restoreSession: (targetId: string, sessionId: string) => Promise<{ restoredTo: string }>;
  purgeSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<{ deleted: string }>;
  purgeSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
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
  startTerminal: (params: TerminalStartRequest) => Promise<TerminalStartResult>;
  startSystemTerminal: (params: SystemTerminalStartRequest) => Promise<{ terminalId: string }>;
  chooseDirectory: () => Promise<{ filePath?: string }>;
  writeTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  stopTerminal: (terminalId: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  readText: () => Promise<string>;
  logPerformance: (label: string, durationMs: number, status?: string) => Promise<void>;
  onTerminalData: (handler: (terminalId: string, data: string) => void) => () => void;
  onTerminalExit: (handler: (terminalId: string, exitCode: number) => void) => () => void;
  onGatewayVendorSwitched: (handler: (event: GatewayVendorSwitchEvent) => void) => () => void;
  onGatewayRequestRecorded: (handler: (event: GatewayRequestRecordedEvent) => void) => () => void;
  openSessionFolder: (targetId: string, sessionId: string) => Promise<void>;
  openPath: (params: OpenPathRequest) => Promise<void>;
  pathExists: (params: OpenPathRequest) => Promise<boolean>;
};
