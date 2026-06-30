import path from "node:path";
import type {
  CodexMessage,
  CodexSession,
  CodexSessionFile,
  RateLimitUsage,
  SessionModelStatus,
  SessionUsage,
  TokenUsage
} from "./types";

export type SessionLine = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

export function parseSessionContent(filePath: string, content: string): CodexSession | null {
  const lines = content.split(/\r?\n/).filter(Boolean);

  let id = "";
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let modelStatus: SessionModelStatus | undefined;
  let cliVersion: string | undefined;
  let usage: SessionUsage | undefined;
  const messages: CodexMessage[] = [];

  for (const line of lines) {
    const item = safeJsonParse<SessionLine>(line);
    if (!item) continue;

    if (item.timestamp) {
      updatedAt = item.timestamp;
      createdAt ||= item.timestamp;
    }

    if (item.type === "session_meta") {
      const payload = item.payload || {};
      id = stringField(payload.id) || id;
      createdAt = stringField(payload.timestamp) || createdAt;
      cwd = stringField(payload.cwd) || cwd;
      model = stringField(payload.model) || model;
      modelStatus = mergeModelStatus(modelStatus, extractModelStatus(item));
      cliVersion = stringField(payload.cli_version) || cliVersion;
      continue;
    }

    modelStatus = mergeModelStatus(modelStatus, extractModelStatus(item));
    model = modelStatus?.model || model;
    usage = extractUsage(item) || usage;

    const message = extractMessage(item);
    if (message && shouldKeepMessage(message)) {
      pushUniqueMessage(messages, { ...message, timestamp: item.timestamp });
    }
  }

  if (!id) {
    id = path.basename(filePath).replace(/^rollout-.+-([0-9a-f-]{36})\.jsonl$/, "$1");
  }

  if (!id || id === path.basename(filePath)) return null;

  const userTitle = messages.find((message) => message.role === "user" && isTitleCandidate(message.text));

  return {
    id,
    title: clampText(userTitle?.text || id, 88),
    cwd,
    createdAt,
    updatedAt,
    model,
    modelStatus,
    cliVersion,
    filePath,
    messageCount: messages.length,
    preview: messages,
    usage
  };
}

export function parseSessionListContent(file: CodexSessionFile, content: string): CodexSession | null {
  const lines = content.split(/\r?\n/).filter(Boolean);

  let id = "";
  let createdAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let modelStatus: SessionModelStatus | undefined;
  let cliVersion: string | undefined;
  let usage: SessionUsage | undefined;
  const messages: CodexMessage[] = [];

  for (const line of lines) {
    const item = safeJsonParse<SessionLine>(line);
    if (!item) continue;

    if (item.timestamp) {
      createdAt ||= item.timestamp;
    }

    if (item.type === "session_meta") {
      const payload = item.payload || {};
      id = stringField(payload.id) || id;
      createdAt = stringField(payload.timestamp) || createdAt;
      cwd = stringField(payload.cwd) || cwd;
      model = stringField(payload.model) || model;
      modelStatus = mergeModelStatus(modelStatus, extractModelStatus(item));
      cliVersion = stringField(payload.cli_version) || cliVersion;
      continue;
    }

    modelStatus = mergeModelStatus(modelStatus, extractModelStatus(item));
    model = modelStatus?.model || model;
    usage = extractUsage(item) || usage;

    if (messages.length >= 8) continue;
    const message = extractMessage(item);
    if (message && shouldKeepMessage(message)) {
      pushUniqueMessage(messages, { ...message, timestamp: item.timestamp });
    }
  }

  if (!id) {
    id = path.basename(file.filePath).replace(/^rollout-.+-([0-9a-f-]{36})\.jsonl$/, "$1");
  }

  if (!id || id === path.basename(file.filePath)) return null;

  const userTitle = messages.find((message) => message.role === "user" && isTitleCandidate(message.text));

  return {
    id,
    title: clampText(userTitle?.text || id, 88),
    cwd,
    createdAt,
    updatedAt: new Date(file.mtimeMs).toISOString(),
    model,
    modelStatus,
    cliVersion,
    filePath: file.filePath,
    messageCount: messages.length,
    preview: messages,
    usage
  };
}

export function extractUsage(item: SessionLine): SessionUsage | null {
  const payload = item.payload;
  if (!payload || item.type !== "event_msg" || payload.type !== "token_count") return null;

  const info = objectField(payload.info);
  const total = normalizeTokenUsage(objectField(info.total_token_usage));
  const last = normalizeTokenUsage(objectField(info.last_token_usage));
  const contextWindow = numberField(info.model_context_window);
  const contextUsedTokens = last?.inputTokens;
  const contextPercent =
    typeof contextUsedTokens === "number" && typeof contextWindow === "number" && contextWindow > 0
      ? Math.min(100, Math.round((contextUsedTokens / contextWindow) * 1000) / 10)
      : undefined;
  const contextLeftPercent =
    typeof contextPercent === "number" ? Math.max(0, Math.round((100 - contextPercent) * 10) / 10) : undefined;

  const rateLimits = objectField(payload.rate_limits);
  const primary = normalizeRateLimit(objectField(rateLimits.primary));
  const secondary = normalizeRateLimit(objectField(rateLimits.secondary));

  if (!total && !last && typeof contextWindow !== "number" && !primary && !secondary) return null;

  return {
    total,
    last,
    contextWindow,
    contextUsedTokens,
    contextPercent,
    contextLeftPercent,
    rateLimits: primary || secondary ? { primary, secondary } : undefined,
    updatedAt: item.timestamp,
    source: "codex-token-count"
  };
}

export function extractModelStatus(item: SessionLine): SessionModelStatus | null {
  const payload = item.payload;
  if (!payload) return null;

  if (item.type === "session_meta") {
    const model = stringField(payload.model);
    const modelProvider = stringField(payload.model_provider);
    return model || modelProvider ? { model, modelProvider } : null;
  }

  if (item.type !== "turn_context") return null;

  const collaborationMode = objectField(payload.collaboration_mode);
  const settings = objectField(collaborationMode.settings);
  const reasoning = stringField(payload.effort) || stringField(settings.reasoning_effort);
  const summaries = stringField(payload.summary);
  const model = stringField(payload.model) || stringField(settings.model);
  const modelProvider = stringField(payload.model_provider);

  return model || reasoning || summaries || modelProvider
    ? {
        model,
        reasoning,
        summaries,
        modelProvider
      }
    : null;
}

export function extractMessage(item: SessionLine): CodexMessage | null {
  const payload = item.payload;
  if (!payload) return null;

  if (item.type === "event_msg" && typeof payload.message === "string") {
    return {
      role: eventRole(stringField(payload.type) || ""),
      text: payload.message
    };
  }

  if (item.type === "response_item" && payload.type === "message") {
    const text = extractContentText(payload.content);
    if (!text) return null;
    return {
      role: messageRole(payload.role),
      text
    };
  }

  return null;
}

export function shouldKeepMessage(message: { text: string }) {
  return Boolean(message.text.trim()) && !isSyntheticUserBlock(message.text);
}

export function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.input_text === "string") return record.input_text;
      if (typeof record.output_text === "string") return record.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function eventRole(type: string): CodexMessage["role"] {
  if (type === "user_message") return "user";
  if (type === "agent_message") return "assistant";
  return "unknown";
}

function messageRole(value: unknown): CodexMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") return value;
  return "unknown";
}

function isTitleCandidate(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized && !isSyntheticUserBlock(normalized);
}

function isSyntheticUserBlock(text: string) {
  const normalized = text.trim();
  return (
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<skill>") ||
    normalized.startsWith("<user_instructions>") ||
    normalized.startsWith("<developer_instructions>")
  );
}

function pushUniqueMessage(messages: CodexMessage[], message: CodexMessage) {
  const previous = messages[messages.length - 1];
  if (previous && previous.role === message.role && previous.text === message.text) return;
  messages.push(message);
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeTokenUsage(value: Record<string, unknown>): TokenUsage | undefined {
  const usage = {
    inputTokens: numberField(value.input_tokens),
    cachedInputTokens: numberField(value.cached_input_tokens),
    outputTokens: numberField(value.output_tokens),
    reasoningOutputTokens: numberField(value.reasoning_output_tokens),
    totalTokens: numberField(value.total_tokens)
  };
  return Object.values(usage).some((item) => typeof item === "number") ? usage : undefined;
}

function normalizeRateLimit(value: Record<string, unknown>): RateLimitUsage | undefined {
  const usage = {
    usedPercent: numberField(value.used_percent),
    windowMinutes: numberField(value.window_minutes),
    resetsAt: stringField(value.resets_at)
  };
  return typeof usage.usedPercent === "number" || typeof usage.windowMinutes === "number" || usage.resetsAt
    ? usage
    : undefined;
}

function mergeModelStatus(
  current: SessionModelStatus | undefined,
  next: SessionModelStatus | null
): SessionModelStatus | undefined {
  if (!next) return current;
  return {
    model: next.model || current?.model,
    reasoning: next.reasoning || current?.reasoning,
    summaries: next.summaries || current?.summaries,
    modelProvider: next.modelProvider || current?.modelProvider
  };
}

function clampText(value: string, length: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}...` : normalized;
}
