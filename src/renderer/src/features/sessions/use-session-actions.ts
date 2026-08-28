import type { Dispatch, SetStateAction } from "react";
import type { AiSession } from "../../types";
import type { SessionView } from "./use-session-loader";

type UseSessionActionsOptions = {
  targetId: string;
  view: SessionView;
  selectedBatchIds: string[];
  selectedBatchSessions: AiSession[];
  activeViewLoaded: boolean;
  closeOpenSessionTerminal: (session: AiSession) => Promise<void>;
  updateCachedSessions: (
    targetId: string,
    view: SessionView,
    updater: (sessions: AiSession[]) => AiSession[]
  ) => void;
  invalidateLoadedView: (targetId: string, view: SessionView) => void;
  loadSessions: (targetId: string, view: SessionView, force?: boolean) => Promise<void>;
  mergeSession: (sessions: AiSession[], session: AiSession) => AiSession[];
  runWorkspaceAction: (message: string, action: () => Promise<unknown>) => Promise<void>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setSelectedSessionDetails: Dispatch<SetStateAction<AiSession | null>>;
  setSelectedBatchIds: Dispatch<SetStateAction<string[]>>;
  setNotice: (message: string) => void;
};

export function createSessionActions({
  targetId,
  view,
  selectedBatchIds,
  selectedBatchSessions,
  activeViewLoaded,
  closeOpenSessionTerminal,
  updateCachedSessions,
  invalidateLoadedView,
  loadSessions,
  mergeSession,
  runWorkspaceAction,
  setSelectedId,
  setSelectedSessionDetails,
  setSelectedBatchIds,
  setNotice
}: UseSessionActionsOptions) {
  async function deleteSessionById(session: AiSession) {
    if (!window.confirm(`删除此会话？\n\n${session.title}`)) return;

    await runWorkspaceAction("正在删除会话...", async () => {
      await closeOpenSessionTerminal(session);
      await window.codexConsole.deleteSession(targetId, session.id, { filePath: session.filePath });
      updateCachedSessions(targetId, "active", (current) => current.filter((item) => item.id !== session.id));
      invalidateLoadedView(targetId, "trash");
      if (view === "trash") await loadSessions(targetId, "trash", true);
      setSelectedId((current) => (current === session.id ? "" : current));
      setSelectedSessionDetails(null);
      setNotice("会话已移动到回收目录。");
    });
  }

  async function restoreSessionById(session: AiSession) {
    await runWorkspaceAction("正在恢复会话...", async () => {
      await window.codexConsole.restoreSession(targetId, session.id);
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => item.id !== session.id));
      if (activeViewLoaded) updateCachedSessions(targetId, "active", (current) => mergeSession(current, session));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (current === session.id ? "" : current));
      setNotice("会话已恢复。");
    });
  }

  async function purgeSessionById(session: AiSession) {
    if (!window.confirm(`是否确认删除？\n\n${session.title}`)) return;

    await runWorkspaceAction("正在彻底删除会话...", async () => {
      await closeOpenSessionTerminal(session);
      await window.codexConsole.purgeSession(targetId, session.id, { filePath: session.filePath });
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => item.id !== session.id));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (current === session.id ? "" : current));
      setNotice("会话已彻底删除。");
    });
  }

  async function deleteSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0 || !window.confirm(`删除选中的 ${items.length} 个会话？`)) return;

    await runWorkspaceAction("正在批量删除会话...", async () => {
      await Promise.all(items.map(closeOpenSessionTerminal));
      await window.codexConsole.deleteSessions(
        targetId,
        items.map((session) => ({ id: session.id, filePath: session.filePath }))
      );
      updateCachedSessions(targetId, "active", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已移动 ${items.length} 个会话到回收目录。`);
    });
  }

  async function restoreSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0) return;

    await runWorkspaceAction("正在批量恢复会话...", async () => {
      for (const session of items) await window.codexConsole.restoreSession(targetId, session.id);
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      if (activeViewLoaded) {
        updateCachedSessions(targetId, "active", (current) => items.reduce((next, session) => mergeSession(next, session), current));
      }
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已恢复 ${items.length} 个会话。`);
    });
  }

  async function purgeSelectedBatch() {
    const items = selectedBatchSessions;
    if (items.length === 0 || !window.confirm(`彻底删除选中的 ${items.length} 个会话？`)) return;

    await runWorkspaceAction("正在批量彻底删除会话...", async () => {
      await Promise.all(items.map(closeOpenSessionTerminal));
      await window.codexConsole.purgeSessions(
        targetId,
        items.map((session) => ({ id: session.id, filePath: session.filePath }))
      );
      updateCachedSessions(targetId, "trash", (current) => current.filter((item) => !selectedBatchIds.includes(item.id)));
      invalidateLoadedView(targetId, "trash");
      setSelectedId((current) => (selectedBatchIds.includes(current) ? "" : current));
      setSelectedBatchIds([]);
      setNotice(`已彻底删除 ${items.length} 个会话。`);
    });
  }

  return {
    deleteSessionById,
    restoreSessionById,
    purgeSessionById,
    deleteSelectedBatch,
    restoreSelectedBatch,
    purgeSelectedBatch
  };
}
