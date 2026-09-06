import type { IpcRenderer } from "electron";
import type {
  AiSession,
  SessionBranchParams,
  SessionExportFormat,
  SessionExportResult,
  SessionFileRef,
  SessionMessagePage,
  SessionMetadata,
  SessionMutationRef
} from "../types";
import { invoke } from "./ipc-bridge";

// 会话列表、详情、变更、导出和 Codex WSL 配置 API。
export function createSessionApi(ipc: IpcRenderer) {
  return {
    listCachedSessions: (targetId: string, view: "active" | "trash") =>
      invoke<AiSession[]>(ipc, "codex:list-cached-sessions", targetId, view),
    listSessions: (targetId: string) => invoke<AiSession[]>(ipc, "codex:list-sessions", targetId),
    listTrashSessions: (targetId: string) => invoke<AiSession[]>(ipc, "codex:list-trash-sessions", targetId),
    searchSessions: (targetId: string, view: "active" | "trash", query: string) =>
      invoke<AiSession[]>(ipc, "codex:search-sessions", targetId, view, query),
    getSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
      invoke<AiSession>(ipc, "codex:get-session", targetId, sessionId, ref),
    getSessionMessagesPage: (targetId: string, sessionId: string, offset: number, limit: number) =>
      invoke<SessionMessagePage>(ipc, "codex:get-session-messages-page", targetId, sessionId, offset, limit),
    getSessionSummary: (targetId: string, sessionId: string) =>
      invoke<AiSession>(ipc, "codex:get-session-summary", targetId, sessionId),
    setSessionCustomTitle: (targetId: string, sessionId: string, title: string) =>
      invoke<SessionMetadata>(ipc, "codex:set-session-custom-title", targetId, sessionId, title),
    listSessionChildren: (targetId: string, parentSessionId: string) =>
      invoke<AiSession[]>(ipc, "codex:list-session-children", targetId, parentSessionId),
    exportSession: (targetId: string, sessionId: string, format: SessionExportFormat) =>
      invoke<SessionExportResult | null>(ipc, "codex:export-session", targetId, sessionId, format),
    branchSession: (params: SessionBranchParams) =>
      invoke<AiSession>(ipc, "codex:branch-session", params.targetId, params.sessionId, params.messageIndex),
    duplicateSession: (targetId: string, sessionId: string, title: string) =>
      invoke<AiSession>(ipc, "codex:duplicate-session", targetId, sessionId, title),
    deleteSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
      invoke<{ movedTo: string }>(ipc, "codex:delete-session", targetId, sessionId, ref),
    deleteSessions: (targetId: string, sessions: SessionMutationRef[]) =>
      invoke<{ processed: Array<SessionMutationRef & { movedTo?: string; deleted?: string }> }>(ipc, "codex:delete-sessions", targetId, sessions),
    restoreSession: (targetId: string, sessionId: string) =>
      invoke<{ restoredTo: string }>(ipc, "codex:restore-session", targetId, sessionId),
    purgeSession: (targetId: string, sessionId: string, ref?: SessionFileRef) =>
      invoke<{ deleted: string }>(ipc, "codex:purge-session", targetId, sessionId, ref),
    purgeSessions: (targetId: string, sessions: SessionMutationRef[]) =>
      invoke<{ processed: Array<SessionMutationRef & { movedTo?: string; deleted?: string }> }>(ipc, "codex:purge-sessions", targetId, sessions),
    setWslCodexHome: (distro: string, codexHome: string) =>
      invoke<{ saved: boolean }>(ipc, "codex:set-wsl-codex-home", distro, codexHome),
    clearWslCodexHome: (distro: string) => invoke<{ cleared: boolean }>(ipc, "codex:clear-wsl-codex-home", distro)
  };
}
