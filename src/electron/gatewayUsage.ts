import type { GatewayUsage } from "./types";

type JsonRecord = Record<string, unknown>;

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
