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
  source: "codex-token-count" | "gemini-message-tokens" | "claude-message-usage" | "qoder-message-usage";
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

export type AiProviderId = "codex" | "gemini" | "claude" | "qoder";

export type AiProviderCapabilities = {
  skills: boolean;
  branch: boolean;
  usage: boolean;
  trash: boolean;
  batchActions: boolean;
  customCwd: boolean;
  export: boolean;
  sessionSettings: boolean;
  duplicate: boolean;
  vendorManagement: boolean;
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

/** 供应商查询接口使用的认证方式。query 表示把密钥放入 key/api_key 查询参数。 */
export type VendorQueryAuthMode =
  | "bearer"
  | "x-api-key"
  | "x-goog-api-key"
  | "api-key"
  | "query"
  | "none";

/** 模型列表查询的可选覆盖配置；未填写时使用平台自动探测。 */
export type VendorModelQueryConfig = {
  endpoint?: string;
  authMode?: VendorQueryAuthMode;
  authHeaderName?: string;
  authQueryName?: string;
  headers?: Record<string, string>;
};

export type VendorBalanceQueryTemplate = "auto" | "generic" | "new-api" | "custom";

/** 余额查询配置。路径字段使用点号分隔的 JSON Path，例如 data.quota。 */
export type VendorBalanceQueryConfig = {
  template?: VendorBalanceQueryTemplate;
  baseUrl?: string;
  endpoint?: string;
  method?: "GET" | "POST";
  authMode?: VendorQueryAuthMode;
  authHeaderName?: string;
  authQueryName?: string;
  headers?: Record<string, string>;
  accessToken?: string;
  userId?: string;
  remainingPath?: string;
  totalPath?: string;
  usedPath?: string;
  unitPath?: string;
  planPath?: string;
  validPath?: string;
  statusPath?: string;
  invalidMessagePath?: string;
  multiplier?: number;
};

export type ApiVendor = {
  id: string;
  providerId: AiProviderId;
  name: string;
  apiKey: string;
  apiBaseUrl: string;
  sort: number;
  pricing?: VendorPricing;
  modelQuery?: VendorModelQueryConfig;
  balanceQuery?: VendorBalanceQueryConfig;
  configs: ApiVendorConfigTemplate[];
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastEnabledAt?: string;
  balance?: VendorBalanceSnapshot;
  balanceStatus?: VendorBalanceStatus;
  balanceError?: string;
  balanceQueriedAt?: string;
  gatewayHealth?: GatewayVendorHealth;
};

export type VendorBalanceProtocol = "generic" | "new-api";

export type VendorBalanceStatus = "idle" | "loading" | "success" | "error";

export type VendorBalanceSnapshot = {
  remaining?: number;
  total?: number;
  used?: number;
  unit?: string;
  planName?: string;
  isValid: boolean;
};

export type VendorBalanceRefreshResult = {
  vendorId: string;
  ok: boolean;
  balance?: VendorBalanceSnapshot;
  message?: string;
  queriedAt: string;
  latencyMs: number;
};

export type VendorBalanceBatchResult = {
  items: VendorBalanceRefreshResult[];
  succeeded: number;
  failed: number;
};

export type GatewayVendorHealthStatus = "healthy" | "degraded" | "open" | "half-open";

export type GatewayVendorHealth = {
  vendorId: string;
  providerId: AiProviderId;
  status: GatewayVendorHealthStatus;
  failureCount: number;
  successCount: number;
  failureRate: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  circuitUntil?: string;
  lastFailureReason?: string;
};

export type ApiVendorEnabledResult = {
  vendorId: string;
  enabled: boolean;
};

export type GatewayUsage = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type GatewayUsageSummary = GatewayUsage & {
  requestCount: number;
  successCount: number;
  failureCount: number;
  switchedCount: number;
  periodStart: string;
  periodEnd: string;
};

// 工作台仅使用安全的失败摘要；诊断明细中的错误文本由主进程截断并清洗后提供。
export type GatewayRecentFailure = {
  vendorId: string;
  providerId: AiProviderId;
  outcome: "timeout" | "error";
  upstreamStatus?: number;
  createdAt: string;
};

export type GatewayFailureDiagnostic = GatewayRecentFailure & {
  retryCount: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
};

export type GatewayFailureDiagnosticsPage = {
  items: GatewayFailureDiagnostic[];
  total: number;
  page: number;
  pageSize: number;
};

export type GatewayFailureOutcomeFilter = "" | "error" | "timeout";

export type ApiVendorInput = {
  id?: string;
  providerId: AiProviderId;
  name: string;
  apiKey: string;
  apiBaseUrl: string;
  sort?: number;
  pricing?: VendorPricing;
  modelQuery?: VendorModelQueryConfig;
  balanceQuery?: VendorBalanceQueryConfig;
  enabled?: boolean;
  configs: ApiVendorConfigTemplate[];
};

/** 供应商按百万 token 计价的美元费率。空值表示尚未配置。 */
export type VendorPricing = {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
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
  configuredFailureThreshold: number;
  configuredCircuitFailureThreshold: number;
  configuredCircuitDurationSeconds: number;
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

export type TerminalStartResult = {
  terminalId: string;
  vendorId?: string;
};

export type GatewayVendorSwitchEvent = {
  terminalId: string;
  vendorId: string;
  reason: "manual" | "candidate-pool" | "failure";
};

/** Gateway 请求完成并写入本地日志后通知工作台刷新统计。 */
export type GatewayRequestRecordedEvent = {
  providerId: AiProviderId;
  vendorId: string;
  outcome: "ok" | "client-aborted" | "timeout" | "error";
  switched: boolean;
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

export type VendorModel = {
  id: string;
  object?: string;
  ownedBy?: string;
  created?: number;
  description?: string;
  pricingMultiplier?: number;
  tags?: string[];
};
