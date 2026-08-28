import type {
  AiProviderId,
  AppCommand,
  CliEnvironmentRequest,
  CliInstallRequest,
  SessionExportFormat,
  SystemTerminalKind,
  SystemTerminalStartRequest,
  WorkspacePresetInput
} from "./types";

const sessionRequestQueue = new Map<string, Promise<unknown>>();

export function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`参数无效：${name}`);
  return value;
}

export function requireCustomTitle(value: unknown) {
  if (typeof value !== "string") throw new Error("参数无效：title");
  const title = value.trim();
  if (title.length > 120) throw new Error("会话名称不能超过 120 个字符。");
  return title;
}

export function coalesceSessionRequest<T>(key: string, action: () => Promise<T>): Promise<T> {
  const existing = sessionRequestQueue.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = action().finally(() => {
    if (sessionRequestQueue.get(key) === request) sessionRequestQueue.delete(key);
  });
  sessionRequestQueue.set(key, request);
  return request;
}

export function requireTerminalData(value: unknown) {
  if (typeof value !== "string" || value.length === 0) throw new Error("参数无效：terminal data");
  return value;
}

export function requireNumber(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`参数无效：${name}`);
  return value;
}

export function requireBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`参数无效：${name}`);
  return value;
}

export function requirePositiveInteger(value: unknown, name: string) {
  const numberValue = requireNumber(value, name);
  if (!Number.isInteger(numberValue) || numberValue <= 0) throw new Error(`参数无效：${name}`);
  return numberValue;
}

export function requireNonNegativeInteger(value: unknown, name: string) {
  const numberValue = requireNumber(value, name);
  if (!Number.isInteger(numberValue) || numberValue < 0) throw new Error(`参数无效：${name}`);
  return numberValue;
}

export function requireMessagePageOffset(value: unknown) {
  if (value === -1) return -1;
  return requireNonNegativeInteger(value, "offset");
}

export function requireView(value: unknown) {
  if (value !== "active" && value !== "trash") throw new Error("参数无效：view");
  return value;
}

export function requireProviderId(value: unknown): AiProviderId {
  if (value !== "codex" && value !== "gemini" && value !== "claude" && value !== "qoder") throw new Error("参数无效：providerId");
  return value;
}

export function requireGatewayPort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("网关端口必须是 0 到 65535 之间的整数。端口 0 表示自动分配。");
  }
  return port;
}

export function requireGatewayFailureThreshold(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("异常切换阈值必须是 1 到 10 之间的整数。");
  }
  return value;
}

export function requireGatewayCircuitFailureThreshold(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error("熔断次数必须是 1 到 20 之间的整数。");
  }
  return value;
}

export function requireGatewayCircuitDurationSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 10 || value > 86_400) {
    throw new Error("熔断持续时间必须是 10 到 86400 秒之间的整数。");
  }
  return value;
}

export function requireAppCommand(value: unknown): AppCommand {
  const commands: AppCommand[] = [
    "quit",
    "openLogDir",
    "about"
  ];
  if (typeof value !== "string" || !commands.includes(value as AppCommand)) throw new Error("参数无效：app command");
  return value as AppCommand;
}

export function requireCliInstallRequest(value: unknown): CliInstallRequest {
  if (!value || typeof value !== "object") throw new Error("参数无效：cli install");
  const request = value as Record<string, unknown>;
  return {
    providerId: requireProviderId(request.providerId),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined,
    nodeMajor: request.nodeMajor === undefined ? undefined : requirePositiveInteger(request.nodeMajor, "nodeMajor"),
    ensureNode: request.ensureNode === true
  };
}

export function requireCliEnvironmentRequest(value: unknown): CliEnvironmentRequest {
  if (!value || typeof value !== "object") throw new Error("参数无效：cli environment");
  const request = value as Record<string, unknown>;
  return {
    providerId: requireProviderId(request.providerId),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined
  };
}

export function requireApiVendorInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor");
  const input = value as Record<string, unknown>;
  const configs = Array.isArray(input.configs) ? input.configs : [];
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined,
    providerId: requireProviderId(input.providerId),
    name: requireString(input.name, "name"),
    apiKey: requireString(input.apiKey, "apiKey"),
    apiBaseUrl: requireString(input.apiBaseUrl, "apiBaseUrl"),
    sort: requireSort(input.sort),
    pricing: requireVendorPricing(input.pricing),
    enabled: input.enabled !== false,
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

function requireSort(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("sort 必须是大于等于 0 的整数。");
  }
  return value;
}

function requireVendorPricing(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数无效：pricing");
  const pricing = value as Record<string, unknown>;
  return {
    inputPerMillionUsd: requireOptionalPrice(pricing.inputPerMillionUsd, "inputPerMillionUsd"),
    outputPerMillionUsd: requireOptionalPrice(pricing.outputPerMillionUsd, "outputPerMillionUsd")
  };
}

function requireOptionalPrice(value: unknown, name: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100) {
    throw new Error(`${name} 必须是非负数，且最多保留 2 位小数。`);
  }
  return value;
}

export function requireApiVendorConfigReadRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor configs");
  const request = value as Record<string, unknown>;
  if (!Array.isArray(request.paths)) throw new Error("参数无效：paths");
  return {
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId.trim() : undefined,
    paths: request.paths.map((item) => requireString(item, "path"))
  };
}

export function requireApiVendorEnableRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：vendor enable");
  const request = value as Record<string, unknown>;
  return {
    vendorId: requireString(request.vendorId, "vendorId"),
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId.trim() : undefined,
    terminalId: typeof request.terminalId === "string" && request.terminalId.trim() ? request.terminalId.trim() : undefined
  };
}

export function requireExportFormat(value: unknown): SessionExportFormat {
  if (value !== "markdown" && value !== "json" && value !== "html") throw new Error("参数无效：format");
  return value;
}

export function requireTerminalStartParams(value: unknown) {
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

export function requireSystemTerminalStartParams(value: unknown): SystemTerminalStartRequest {
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

export function requireSystemTerminalKind(value: unknown): SystemTerminalKind | undefined {
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

export function requireWorkspacePresetInput(value: unknown): WorkspacePresetInput {
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

export function requireCompressionPromptInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：compression prompt");
  const input = value as Record<string, unknown>;
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined,
    name: typeof input.name === "string" ? input.name : "",
    content: requireString(input.content, "content")
  };
}

export function requireOpenPathRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("参数无效：open path");
  const request = value as Record<string, unknown>;
  return {
    targetId: typeof request.targetId === "string" && request.targetId.trim() ? request.targetId : undefined,
    path: requireString(request.path, "path")
  };
}

export function requireSessionFileRef(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") throw new Error("参数无效：session file ref");
  const input = value as Record<string, unknown>;
  return {
    filePath: typeof input.filePath === "string" && input.filePath.trim() ? input.filePath.trim() : undefined
  };
}

export function requireSessionMutationRefs(value: unknown) {
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
