import { useEffect, useState } from "react";
import type { AiSession, CompressionPrompt } from "../../types";
import {
  compressionPromptToDraft,
  createEmptyCompressionPromptDraft,
  renderCompressionPrompt,
  validateCompressionPromptDraft,
  type CompressionPromptDraft,
  type CompressionPromptFieldErrors
} from "./compression-prompt";

type CompressionToast = { message: string; tone: "success" | "error" } | null;

// 压缩提示词管理的全部状态与副作用，从 App.tsx 抽出为自定义 Hook。
// 通过 getActiveSession 懒解析当前会话，避免与会话状态强耦合。
export function useCompressionPrompts({ getActiveSession }: { getActiveSession: () => AiSession | null }) {
  const [compressionManagerOpen, setCompressionManagerOpen] = useState(false);
  const [compressionManagerMode, setCompressionManagerMode] = useState<"list" | "form">("list");
  const [compressionPrompts, setCompressionPrompts] = useState<CompressionPrompt[]>([]);
  const [compressionDraft, setCompressionDraft] = useState<CompressionPromptDraft>(() => createEmptyCompressionPromptDraft());
  const [compressionBusy, setCompressionBusy] = useState("");
  const [compressionError, setCompressionError] = useState("");
  const [compressionFieldErrors, setCompressionFieldErrors] = useState<CompressionPromptFieldErrors>({});
  const [compressionToast, setCompressionToast] = useState<CompressionToast>(null);

  useEffect(() => {
    if (!compressionToast) return;
    const timer = window.setTimeout(() => setCompressionToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [compressionToast]);

  async function openCompressionManager() {
    setCompressionManagerOpen(true);
    setCompressionManagerMode("list");
    setCompressionError("");
    setCompressionFieldErrors({});
    setCompressionToast(null);
    await loadCompressionPrompts();
  }

  async function loadCompressionPrompts() {
    setCompressionBusy("正在加载压缩提示...");
    setCompressionError("");
    try {
      const list = await window.codexConsole.listCompressionPrompts();
      setCompressionPrompts(list);
      setCompressionDraft((current) => current.id ? current : list[0] ? compressionPromptToDraft(list[0]) : current);
    } catch (loadError: any) {
      setCompressionError(loadError?.message || "加载压缩提示失败。");
    } finally {
      setCompressionBusy("");
    }
  }

  function editCompressionPromptDraft(prompt?: CompressionPrompt) {
    setCompressionToast(null);
    setCompressionError("");
    setCompressionFieldErrors({});
    setCompressionDraft(prompt ? compressionPromptToDraft(prompt) : createEmptyCompressionPromptDraft());
    setCompressionManagerMode("form");
  }

  async function saveCompressionPromptDraft() {
    const fieldErrors = validateCompressionPromptDraft(compressionDraft);
    if (Object.keys(fieldErrors).length > 0) {
      setCompressionFieldErrors(fieldErrors);
      setCompressionError("");
      return;
    }
    setCompressionBusy("正在保存压缩提示...");
    setCompressionError("");
    setCompressionFieldErrors({});
    try {
      const saved = await window.codexConsole.saveCompressionPrompt(compressionDraft);
      const list = await window.codexConsole.listCompressionPrompts();
      setCompressionPrompts(list);
      setCompressionDraft(compressionPromptToDraft(list.find((prompt) => prompt.id === saved.id) || saved));
      setCompressionManagerMode("list");
      setCompressionToast({ message: "压缩提示已保存。", tone: "success" });
    } catch (saveError: any) {
      setCompressionError(saveError?.message || "保存压缩提示失败。");
    } finally {
      setCompressionBusy("");
    }
  }

  async function deleteCompressionPromptById(promptId: string) {
    setCompressionBusy("正在删除压缩提示...");
    setCompressionError("");
    setCompressionToast(null);
    try {
      await window.codexConsole.deleteCompressionPrompt(promptId);
      const list = await window.codexConsole.listCompressionPrompts();
      setCompressionPrompts(list);
      setCompressionDraft(list[0] ? compressionPromptToDraft(list[0]) : createEmptyCompressionPromptDraft());
      setCompressionManagerMode("list");
      setCompressionToast({ message: "压缩提示已删除。", tone: "success" });
    } catch (deleteError: any) {
      setCompressionToast({ message: deleteError?.message || "删除压缩提示失败。", tone: "error" });
    } finally {
      setCompressionBusy("");
    }
  }

  async function generateCompressionPrompt(prompt: CompressionPrompt) {
    const session = getActiveSession();
    await window.codexConsole.copyText(renderCompressionPrompt(prompt.content, session));
    setCompressionToast({ message: "压缩提示已复制到剪贴板。", tone: "success" });
  }

  return {
    compressionManagerOpen,
    setCompressionManagerOpen,
    compressionManagerMode,
    setCompressionManagerMode,
    compressionPrompts,
    compressionDraft,
    setCompressionDraft,
    compressionBusy,
    compressionError,
    compressionFieldErrors,
    setCompressionFieldErrors,
    compressionToast,
    openCompressionManager,
    editCompressionPromptDraft,
    saveCompressionPromptDraft,
    deleteCompressionPromptById,
    generateCompressionPrompt
  };
}
