import { useState } from "react";
import type { AiSession, SessionMetadata } from "./types";

type UseSessionTitleDialogsOptions = {
  targetId: string;
  applyCustomTitle: (targetId: string, sessionId: string, metadata: SessionMetadata) => void;
  applyDuplicatedSession: (session: AiSession) => void;
  setNotice: (message: string) => void;
};

export function useSessionTitleDialogs({
  targetId,
  applyCustomTitle,
  applyDuplicatedSession,
  setNotice
}: UseSessionTitleDialogsOptions) {
  const [renameSession, setRenameSession] = useState<AiSession | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [duplicateSession, setDuplicateSession] = useState<AiSession | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState("");
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicateBusy, setDuplicateBusy] = useState(false);

  function openRenameSession(session: AiSession) {
    setRenameSession(session);
    setRenameDraft(session.metadata?.customTitle || session.title);
    setRenameError("");
  }

  function closeRenameSession() {
    if (renameBusy) return;
    setRenameSession(null);
    setRenameError("");
  }

  function openDuplicateSession(session: AiSession) {
    setDuplicateSession(session);
    setDuplicateDraft("");
    setDuplicateError("");
  }

  function closeDuplicateSession() {
    if (duplicateBusy) return;
    setDuplicateSession(null);
    setDuplicateError("");
  }

  async function duplicateSelectedSession() {
    if (!duplicateSession) return;
    setDuplicateBusy(true);
    setDuplicateError("");
    try {
      const duplicated = await window.codexConsole.duplicateSession(targetId, duplicateSession.id, duplicateDraft.trim());
      applyDuplicatedSession(duplicated);
      setDuplicateSession(null);
      setNotice("会话已复制。");
    } catch (duplicateError: any) {
      setDuplicateError(duplicateError?.message || "复制会话失败。");
    } finally {
      setDuplicateBusy(false);
    }
  }

  async function saveCustomSessionTitle(value = renameDraft) {
    if (!renameSession) return;
    const title = value.trim();
    if (!title && value !== "") {
      setRenameError("请输入会话名称。");
      return;
    }

    setRenameBusy(true);
    setRenameError("");
    try {
      const metadata = await window.codexConsole.setSessionCustomTitle(targetId, renameSession.id, title);
      applyCustomTitle(targetId, renameSession.id, metadata);
      setNotice(title ? "会话名称已保存。" : "已恢复自动标题。");
      setRenameSession(null);
    } catch (saveError: any) {
      setRenameError(saveError?.message || "保存会话名称失败。");
    } finally {
      setRenameBusy(false);
    }
  }

  return {
    renameSession,
    renameDraft,
    setRenameDraft,
    renameError,
    setRenameError,
    renameBusy,
    openRenameSession,
    closeRenameSession,
    saveCustomSessionTitle,
    duplicateSession,
    duplicateDraft,
    setDuplicateDraft,
    duplicateError,
    setDuplicateError,
    duplicateBusy,
    openDuplicateSession,
    closeDuplicateSession,
    duplicateSelectedSession
  };
}
