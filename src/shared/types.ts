export type CodexMessage = {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  text: string;
  timestamp?: string;
};

export type CodexSession = {
  id: string;
  title: string;
  sourceTitle?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  modelStatus?: SessionModelStatus;
  cliVersion?: string;
  filePath: string;
  fileMtimeMs?: number;
  fileSize?: number;
  messageCount: number;
  preview: CodexMessage[];
  previewOffset?: number;
  usage?: SessionUsage;
  metadata?: SessionMetadata;
};

export type SessionFileRef = {
  filePath?: string;
};

export type SessionMutationRef = SessionFileRef & {
  id: string;
};

export type SessionBatchMutationResult = {
  processed: Array<SessionMutationRef & { movedTo?: string; deleted?: string }>;
};

export type TokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type RateLimitUsage = {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
};

export type SessionUsage = {
  total?: TokenUsage;
  last?: TokenUsage;
  contextWindow?: number;
  contextUsedTokens?: number;
  contextPercent?: number;
  contextLeftPercent?: number;
  rateLimits?: {
    primary?: RateLimitUsage;
    secondary?: RateLimitUsage;
  };
  updatedAt?: string;
  source: "codex-token-count" | "gemini-message-tokens" | "claude-message-usage";
};

export type SessionModelStatus = {
  model?: string;
  reasoning?: string;
  summaries?: string;
  modelProvider?: string;
};

export type SessionMetadata = {
  updatedAt?: string;
  customTitle?: string;
  branch?: SessionBranchMetadata;
};

export type SessionBranchMetadata = {
  parentTargetId?: string;
  parentSessionId?: string;
  parentMessageIndex?: number;
  createdBy?: "branch" | "manual";
};

export type AiProviderId = "codex" | "gemini" | "claude";

export type AiProviderCapabilities = {
  skills: boolean;
  branch: boolean;
  usage: boolean;
  trash: boolean;
  batchActions: boolean;
  customCwd: boolean;
  export: boolean;
  sessionSettings: boolean;
};

export type AiProviderSummary = {
  id: AiProviderId;
  label: string;
  capabilities: AiProviderCapabilities;
};

export type ApiVendorConfigTemplate = {
  id?: string;
  providerId: AiProviderId;
  label?: string;
  enabled: boolean;
  targetPath: string;
  content: string;
};

export type ApiVendor = {
  id: string;
  providerId: AiProviderId;
  name: string;
  apiKey: string;
  apiBaseUrl: string;
  writeCommonConfig?: boolean;
  configs: ApiVendorConfigTemplate[];
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastEnabledAt?: string;
};

export type ApiVendorInput = {
  id?: string;
  providerId: AiProviderId;
  name: string;
  apiKey: string;
  apiBaseUrl: string;
  writeCommonConfig?: boolean;
  configs: ApiVendorConfigTemplate[];
};

export type ApiVendorConfigReadRequest = {
  targetId?: string;
  paths: string[];
};

export type ApiVendorConfigReadResult = {
  files: Array<{
    path: string;
    content: string;
  }>;
};

export type ApiVendorEnableRequest = {
  vendorId: string;
  targetId?: string;
  terminalId?: string;
};

export type ApiVendorEnableResult = {
  vendorId: string;
  written: string[];
  backupRoot: string;
  switched?: boolean;
  switchReason?: "terminal-not-found" | "gateway-not-active" | "route-not-found" | "provider-mismatch";
};

export type CompressionPrompt = {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type CompressionPromptInput = {
  id?: string;
  name: string;
  content: string;
};

export type CliInstallRequest = {
  providerId: AiProviderId;
  targetId?: string;
  nodeMajor?: number;
  ensureNode?: boolean;
};

export type CliInstallResult = {
  providerId: AiProviderId;
  command: string;
  stdout: string;
  stderr: string;
};

export type CliEnvironmentRequest = {
  providerId: AiProviderId;
  targetId?: string;
};

export type CliEnvironmentStatus = {
  providerId: AiProviderId;
  targetId?: string;
  scope: "local" | "wsl";
  platform: "windows" | "macos" | "linux";
  minimumNodeMajor: number;
  recommendedNodeMajor: number;
  nodeVersion?: string;
  npmVersion?: string;
  nvmVersion?: string;
  cliVersion?: string;
  nodePath?: string;
  npmPath?: string;
  hasNode: boolean;
  hasNpm: boolean;
  hasNvm: boolean;
  hasCli: boolean;
  nodeManagedByNvm: boolean;
  nodeMeetsMinimum: boolean;
  canInstallCli: boolean;
  canInstallNodeWithNvm: boolean;
  messages: string[];
};

export type AppCommand =
  | "quit"
  | "openLogDir"
  | "about";

export type GatewayPortStatus = {
  configuredPort: number;
  activePort: number;
};

export type GatewayPortUpdateResult = GatewayPortStatus & {
  applied: boolean;
};

export type CodexSessionFile = {
  filePath: string;
  mtimeMs: number;
  size: number;
};

export type CodexTarget = {
  id: string;
  provider: AiProviderId;
  label: string;
  kind: "local" | "wsl";
  distro?: string;
  codexHome?: string;
  available: boolean;
  detail?: string;
};

export type AiMessage = CodexMessage;
export type AiSession = CodexSession;
export type AiSessionFile = CodexSessionFile;
export type AiTarget = CodexTarget;

// 会话详情按页读取原始 JSONL 时使用；offset 是过滤后可见消息的绝对序号。
// 仅首屏可传 -1，请求末尾 limit 条消息并返回其实际绝对偏移。
export type SessionMessagePage = {
  offset: number;
  messages: AiMessage[];
  hasMore: boolean;
};

export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  sourceName?: string;
};

export type TerminalStartParams = {
  targetId: string;
  sessionId?: string;
  cwd?: string;
  codexHome?: string;
  vendorId?: string;
  useCodexCwdFlag?: boolean;
  cliArgs?: string;
};

export type SessionBranchParams = {
  targetId: string;
  sessionId: string;
  messageIndex: number;
};

export type TerminalStartRequest = TerminalStartParams & {
  cols?: number;
  rows?: number;
};

export type SystemTerminalKind =
  | "auto"
  | "powershell"
  | "cmd"
  | "git-bash"
  | "wsl"
  | "wsl-default"
  | "bash"
  | "zsh"
  | "fish";

export type SystemTerminalStartRequest = {
  targetId?: string;
  kind?: SystemTerminalKind;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type OpenPathRequest = {
  targetId?: string;
  path: string;
};

export type SessionExportFormat = "markdown" | "json" | "html";

export type SessionExportResult = {
  filePath: string;
  format: SessionExportFormat;
};

export type WorkspacePreset = {
  id: string;
  name: string;
  cwd: string;
  targetKind?: "local" | "wsl";
  prompt?: string;
  cliArgs?: string;
  updatedAt: string;
};

export type WorkspacePresetInput = {
  name: string;
  cwd: string;
  targetKind?: "local" | "wsl";
  prompt?: string;
  cliArgs?: string;
};
