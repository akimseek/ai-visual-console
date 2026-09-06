import type { GatewayUsage, GatewayUsageDimension, GatewayUsageReport, GatewayUsageSummary, AiProviderId } from "../types";

type JsonRecord = Record<string, unknown>;

export type GatewayUsageAggregateRow = {
  vendorId: string;
  vendorName: string;
  providerId: AiProviderId;
  model?: string;
  outcome: "ok" | "client-aborted" | "timeout" | "error";
  durationMs: number;
  retryCount: number;
  switched: boolean;
  usageJson?: string | null;
};

// 将请求记录聚合为总览、供应商和模型三个维度；数据库查询与渲染层都不承担这段统计规则。
export function aggregateGatewayUsage(rows: GatewayUsageAggregateRow[], periodStart: string, periodEnd: string): GatewayUsageReport {
  const vendors = new Map<string, GatewayUsageDimensionAccumulator>();
  const models = new Map<string, GatewayUsageDimensionAccumulator>();
  const summary = createAccumulator("summary", "全部请求", "codex");

  for (const row of rows) {
    const usage = parseStoredUsage(row.usageJson);
    addUsageRow(summary, row, usage);
    const vendor = getOrCreateDimension(vendors, row.vendorId, row.vendorName, row.providerId);
    addUsageRow(vendor, row, usage);
    const model = row.model?.trim() || "未标注模型";
    const modelKey = `${row.providerId}:${model}`;
    const modelDimension = getOrCreateDimension(models, modelKey, model, row.providerId);
    addUsageRow(modelDimension, row, usage);
  }

  return {
    summary: toSummary(summary, periodStart, periodEnd),
    vendors: [...vendors.values()].map(toDimension).sort(sortDimensions),
    models: [...models.values()].map(toDimension).sort(sortDimensions)
  };
}

/** 从 OpenAI/Anthropic/Gemini 常见 usage 结构中提取统一 token 字段。 */
export function parseGatewayUsage(body: unknown): GatewayUsage | undefined {
  if (!isRecord(body)) return undefined;
  const root = body;
  const response = isRecord(root.response) ? root.response : undefined;
  const usage = isRecord(root.usage) ? root.usage : response && isRecord(response.usage) ? response.usage : root;
  const inputTokens = numberAt(usage, ["input_tokens", "prompt_tokens", "inputTokenCount"]);
  const outputTokens = numberAt(usage, ["output_tokens", "completion_tokens", "outputTokenCount"]);
  const cachedInputTokens = numberAt(usage, ["input_tokens_details.cached_tokens", "prompt_tokens_details.cached_tokens", "cached_tokens"]);
  const reasoningTokens = numberAt(usage, ["completion_tokens_details.reasoning_tokens", "reasoning_tokens", "thoughtsTokenCount"]);
  if ([inputTokens, outputTokens, cachedInputTokens, reasoningTokens].every((value) => value === undefined)) return undefined;
  const totalTokens = numberAt(usage, ["total_tokens", "totalTokenCount"])
    ?? ([inputTokens, outputTokens].some((value) => value !== undefined) ? (inputTokens || 0) + (outputTokens || 0) : undefined);
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens };
}

export function mergeGatewayUsage(target: GatewayUsage, next: GatewayUsage) {
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens"] as const) {
    if (next[key] !== undefined) target[key] = Math.max(target[key] || 0, next[key] || 0);
  }
}

export function parseUsageFromChunk(chunk: string): GatewayUsage | undefined {
  let latest: GatewayUsage | undefined;
  for (const line of chunk.split(/\r?\n/)) {
    const payload = line.replace(/^data:\s*/, "").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = parseGatewayUsage(JSON.parse(payload) as unknown);
      if (parsed) latest = parsed;
    } catch {
      // SSE 分块可能跨越多次网络读取，当前分块不是完整 JSON 时忽略。
    }
  }
  return latest;
}

type GatewayUsageDimensionAccumulator = GatewayUsage & {
  key: string;
  label: string;
  providerId: AiProviderId;
  requestCount: number;
  successCount: number;
  failureCount: number;
  switchedCount: number;
  retryCount: number;
  durationMs: number;
};

function createAccumulator(key: string, label: string, providerId: AiProviderId): GatewayUsageDimensionAccumulator {
  return { key, label, providerId, requestCount: 0, successCount: 0, failureCount: 0, switchedCount: 0, retryCount: 0, durationMs: 0 };
}

function getOrCreateDimension(map: Map<string, GatewayUsageDimensionAccumulator>, key: string, label: string, providerId: AiProviderId) {
  let dimension = map.get(key);
  if (!dimension) {
    dimension = createAccumulator(key, label, providerId);
    map.set(key, dimension);
  }
  return dimension;
}

function addUsageRow(target: GatewayUsageDimensionAccumulator, row: GatewayUsageAggregateRow, usage: GatewayUsage | undefined) {
  target.requestCount += 1;
  if (row.outcome === "ok") target.successCount += 1;
  else target.failureCount += 1;
  if (row.switched) target.switchedCount += 1;
  target.retryCount += Math.max(0, row.retryCount || 0);
  target.durationMs += Math.max(0, row.durationMs || 0);
  if (!usage) return;
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "totalTokens"] as const) {
    if (typeof usage[key] === "number") target[key] = (target[key] || 0) + usage[key]!;
  }
  if (typeof usage.costUsd === "number") target.costUsd = (target.costUsd || 0) + usage.costUsd;
}

function parseStoredUsage(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as GatewayUsage;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(value: GatewayUsageDimensionAccumulator, periodStart: string, periodEnd: string): GatewayUsageSummary {
  const { key: _key, label: _label, providerId: _providerId, durationMs, ...rest } = value;
  return { ...rest, averageDurationMs: value.requestCount ? durationMs / value.requestCount : 0, periodStart, periodEnd };
}

function toDimension(value: GatewayUsageDimensionAccumulator): GatewayUsageDimension {
  const { durationMs, ...rest } = value;
  return { ...rest, averageDurationMs: value.requestCount ? durationMs / value.requestCount : 0 };
}

function sortDimensions(left: GatewayUsageDimension, right: GatewayUsageDimension) {
  return right.requestCount - left.requestCount || left.label.localeCompare(right.label);
}

function numberAt(root: JsonRecord, paths: string[]) {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
