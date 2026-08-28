import type { AiSession, InstalledSkill, SessionUsage, TokenUsage } from "../../types";

// 会话列表/用量展示相关的纯函数（无 React 状态），从 App.tsx 抽出以降低单文件体积，
// 并可被 UI 子组件直接复用，避免反向 import App.tsx 造成的循环依赖。

export function tabKey(targetId: string, sessionId: string) {
  return `${targetId}:${sessionId}`;
}

export function skillSourceName(skill: InstalledSkill) {
  return skill.sourceName || (skill.enabled ? skill.name : `${skill.name}.disabled`);
}

export function mergeSession(sessions: AiSession[], session: AiSession) {
  if (sessions.some((item) => item.id === session.id)) return sessions;
  return [session, ...sessions].sort((left, right) => {
    return sessionTimestamp(right) - sessionTimestamp(left);
  });
}

export function replaceCachedSession(sessions: AiSession[], session: AiSession) {
  let changed = false;
  const next = sessions.map((item) => {
    if (item.id !== session.id) return item;
    changed = true;
    return session;
  });
  return changed ? next : sessions;
}

export function localFilterSessions(sessions: AiSession[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;

  return sessions.filter((session) => {
    const haystack = [
      session.title,
      session.sourceTitle,
      session.id,
      session.cwd,
      session.model,
      session.cliVersion,
      ...session.preview.map((message) => message.text)
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function sessionTimestamp(session: AiSession) {
  const value = session.updatedAt || session.createdAt;
  return value ? new Date(value).getTime() : 0;
}

export function formatModelStatus(session?: AiSession | null) {
  const model = session?.modelStatus?.model || session?.model;
  if (!model) return { label: "-", title: "当前会话没有模型状态记录" };

  const reasoning = session?.modelStatus?.reasoning;
  const summaries = session?.modelStatus?.summaries;
  const provider = session?.modelStatus?.modelProvider;
  const details = [
    reasoning ? `reasoning ${reasoning}` : "",
    summaries ? `summaries ${summaries}` : ""
  ].filter(Boolean);
  const title = details.length > 0 ? `${model} (${details.join(", ")})` : model;
  return {
    label: model,
    title: provider ? `${title} / ${provider}` : title
  };
}

export function formatTokenUsage(session?: AiSession | null) {
  const total = session?.usage?.total;
  if (!total?.totalTokens) return { label: "-", title: "当前会话没有 Token usage 记录" };

  const input = formatCompactNumber(total.inputTokens);
  const cached = formatCompactNumber(total.cachedInputTokens);
  const output = formatCompactNumber(total.outputTokens);
  const reasoning = formatCompactNumber(total.reasoningOutputTokens);
  const totalText = formatCompactNumber(total.totalTokens);
  return {
    label: totalText,
    title: `总计 ${totalText}，输入 ${input}，缓存输入 ${cached}，输出 ${output}，推理输出 ${reasoning}`
  };
}

export function formatContextUsage(session?: AiSession | null) {
  const usage = session?.usage;
  if (typeof usage?.contextLeftPercent !== "number") {
    return { label: "-", title: "当前会话没有上下文窗口 usage 记录" };
  }

  const used = formatCompactNumber(usage.contextUsedTokens);
  const windowSize = formatCompactNumber(usage.contextWindow);
  return {
    label: `${usage.contextLeftPercent}% left`,
    title: `上下文约 ${usage.contextLeftPercent}% 剩余，${used} used / ${windowSize}`
  };
}

export function formatCompactNumber(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}K`;
  return `${value}`;
}

export function formatFullNumber(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value}%`;
}

export function buildTokenRows(usage?: TokenUsage) {
  return [
    { label: "总量", value: formatFullNumber(usage?.totalTokens) },
    { label: "输入", value: formatFullNumber(usage?.inputTokens) },
    { label: "缓存输入", value: formatFullNumber(usage?.cachedInputTokens) },
    { label: "输出", value: formatFullNumber(usage?.outputTokens) },
    { label: "推理/思考", value: formatFullNumber(usage?.reasoningOutputTokens) }
  ];
}

export function usageSourceLabel(source?: SessionUsage["source"]) {
  if (source === "codex-token-count") return "Codex token_count";
  if (source === "gemini-message-tokens") return "Gemini tokens";
  if (source === "claude-message-usage") return "Claude usage";
  if (source === "qoder-message-usage") return "Qoder usage";
  return "无 usage 数据";
}

export function trimNumber(value: number) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

export function shortSessionId(sessionId: string) {
  return sessionId.slice(0, 8);
}
