import type { AiSession, CompressionPrompt, CompressionPromptInput } from "../../types";
import { formatContextUsage, formatModelStatus, formatTokenUsage } from "../sessions/session-format";

// 压缩提示词的草稿与渲染纯逻辑（无 React 状态），从 App.tsx 抽出便于复用与测试。

export type CompressionPromptDraft = CompressionPromptInput;
export type CompressionPromptFieldName = "name" | "content";
export type CompressionPromptFieldErrors = Partial<Record<CompressionPromptFieldName, string>>;

export function createEmptyCompressionPromptDraft(): CompressionPromptDraft {
  return {
    name: "",
    content: ""
  };
}

export function compressionPromptToDraft(prompt: CompressionPrompt): CompressionPromptDraft {
  return {
    id: prompt.id,
    name: prompt.name,
    content: prompt.content
  };
}

export function validateCompressionPromptDraft(draft: CompressionPromptDraft): CompressionPromptFieldErrors {
  const errors: CompressionPromptFieldErrors = {};
  if (!draft.name.trim()) errors.name = "请输入提示名称。";
  if (!draft.content.trim()) errors.content = "请输入提示内容。";
  return errors;
}

export function compressionPromptPreview(content: string) {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || "无内容";
}

export function renderCompressionPrompt(content: string, session?: AiSession | null) {
  const replacements: Record<string, string> = {
    session_id: session?.id || "-",
    session_title: session?.title || "-",
    session_cwd: session?.cwd || "-",
    session_model: formatModelStatus(session).title,
    session_token: formatTokenUsage(session).label,
    session_context: formatContextUsage(session).label
  };

  return content.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => replacements[key] ?? match);
}
