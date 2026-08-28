import fs from "node:fs/promises";
import path from "node:path";
import type { CodexMessage, CodexSession, SessionExportFormat, SessionExportResult } from "../types";

export async function exportSessionToFile(
  session: CodexSession,
  format: SessionExportFormat,
  filePath: string
): Promise<SessionExportResult> {
  const content = formatSession(sanitizeSessionForExport(session), format);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return { filePath, format };
}

function sanitizeSessionForExport(session: CodexSession): CodexSession {
  const preview = session.preview.filter(isVisibleExportMessage);
  return {
    ...session,
    messageCount: preview.length,
    preview
  };
}

function isVisibleExportMessage(message: CodexMessage) {
  return !message.text.includes("<turn_aborted>") && !message.text.includes("<permissions instructions>");
}

function formatSession(session: CodexSession, format: SessionExportFormat) {
  if (format === "json") return `${JSON.stringify(session, null, 2)}\n`;
  if (format === "html") return formatHtml(session);
  return formatMarkdown(session);
}

function formatMarkdown(session: CodexSession) {
  const metadata = session.metadata;
  const lines = [
    `# ${escapeMarkdown(session.title)}`,
    "",
    `- 会话编号：\`${session.id}\``,
    `- 创建时间：${session.createdAt || "-"}`,
    `- 更新时间：${session.updatedAt || "-"}`,
    `- 工作目录：${session.cwd || "-"}`,
    `- 模型：${formatModelStatus(session)}`,
    `- CLI 版本：${session.cliVersion || "-"}`,
    `- Token：${formatTokenUsage(session)}`,
    `- 上下文：${formatContextUsage(session)}`
  ];

  if (metadata?.branch?.parentSessionId) {
    lines.push(`- 来源会话：\`${metadata.branch.parentSessionId}\``);
    if (typeof metadata.branch.parentMessageIndex === "number") {
      lines.push(`- 来源消息位置：${metadata.branch.parentMessageIndex}`);
    }
  }

  lines.push("", "## 对话", "");
  for (const message of session.preview) {
    lines.push(`### ${roleLabel(message.role)}`);
    if (message.timestamp) lines.push(`_时间：${message.timestamp}_`, "");
    lines.push(message.text.trim() || "(空)", "");
  }

  return `${lines.join("\n")}\n`;
}

function formatHtml(session: CodexSession) {
  const metadata = session.metadata;
  const metaRows = [
    ["会话编号", session.id],
    ["创建时间", session.createdAt || "-"],
    ["更新时间", session.updatedAt || "-"],
    ["工作目录", session.cwd || "-"],
    ["模型", formatModelStatus(session)],
    ["CLI 版本", session.cliVersion || "-"],
    ["Token", formatTokenUsage(session)],
    ["上下文", formatContextUsage(session)],
    ["来源会话", metadata?.branch?.parentSessionId || "-"],
    ["来源消息位置", metadata?.branch?.parentMessageIndex?.toString() || "-"]
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(session.title)}</title>
  <style>
    body { margin: 32px; color: #1f2937; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { font-size: 24px; }
    table { border-collapse: collapse; margin: 16px 0 28px; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { width: 140px; background: #f3f4f6; }
    article { border: 1px solid #d1d5db; border-left: 4px solid #6b7280; border-radius: 8px; margin: 12px 0; padding: 12px 14px; }
    article.user { border-left-color: #3268d5; }
    article.assistant { border-left-color: #2b8a66; }
    article header { color: #6b7280; font-size: 12px; margin-bottom: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; font: inherit; margin: 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(session.title)}</h1>
  <table>
    <tbody>
${metaRows.map(([key, value]) => `      <tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
    </tbody>
  </table>
  <h2>对话</h2>
${session.preview.map(formatHtmlMessage).join("\n")}
</body>
</html>
`;
}

function formatHtmlMessage(message: CodexMessage) {
  return `  <article class="${escapeHtml(message.role)}">
    <header>${escapeHtml(roleLabel(message.role))}${message.timestamp ? ` · ${escapeHtml(message.timestamp)}` : ""}</header>
    <pre>${escapeHtml(message.text)}</pre>
  </article>`;
}

function roleLabel(role: CodexMessage["role"]) {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  if (role === "tool") return "工具";
  return "未知";
}

function formatTokenUsage(session: CodexSession) {
  const total = session.usage?.total;
  if (!total?.totalTokens) return "-";
  return [
    `总计 ${formatNumber(total.totalTokens)}`,
    `输入 ${formatNumber(total.inputTokens)}`,
    `缓存输入 ${formatNumber(total.cachedInputTokens)}`,
    `输出 ${formatNumber(total.outputTokens)}`,
    `推理输出 ${formatNumber(total.reasoningOutputTokens)}`
  ].join(" / ");
}

function formatContextUsage(session: CodexSession) {
  const usage = session.usage;
  if (typeof usage?.contextLeftPercent !== "number") return "-";
  return `${usage.contextLeftPercent}% left (${formatNumber(usage.contextUsedTokens)} used / ${formatNumber(usage.contextWindow)})`;
}

function formatNumber(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "-";
}

function formatModelStatus(session: CodexSession) {
  const model = session.modelStatus?.model || session.model;
  if (!model) return "-";
  const details = [
    session.modelStatus?.reasoning ? `reasoning ${session.modelStatus.reasoning}` : "",
    session.modelStatus?.summaries ? `summaries ${session.modelStatus.summaries}` : ""
  ].filter(Boolean);
  const label = details.length > 0 ? `${model} (${details.join(", ")})` : model;
  return session.modelStatus?.modelProvider ? `${label} / ${session.modelStatus.modelProvider}` : label;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}
