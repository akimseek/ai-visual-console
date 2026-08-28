import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  branchSession,
  clearWslCodexHome,
  deleteSession,
  deleteSessions,
  duplicateSession,
  getSession,
  getSessionMessagesPage,
  getSessionSummary,
  listCachedSessions,
  listCachedTargets,
  listSessions,
  listSessionsByParent,
  listTargets,
  listTrashSessions,
  purgeSession,
  purgeSessions,
  restoreSession,
  searchSessions,
  setWslCodexHome
} from "../providers/ai-providers";
import { exportSessionToFile } from "../providers/session-export";
import { setSessionCustomTitle } from "../providers/session-metadata";
import {
  coalesceSessionRequest,
  requireString,
  requireView,
  requireProviderId,
  requireSessionFileRef,
  requireMessagePageOffset,
  requirePositiveInteger,
  requireNonNegativeInteger,
  requireCustomTitle,
  requireExportFormat,
  requireSessionMutationRefs
} from "./validation";

function exportDialogOptions(title: string, format: string) {
  const extension = format === "markdown" ? "md" : format;
  return {
    title: "导出会话",
    defaultPath: `${safeFileName(title || "codex-session")}.${extension}`,
    filters: [
      format === "markdown"
        ? { name: "Markdown", extensions: ["md"] }
        : format === "json"
          ? { name: "JSON", extensions: ["json"] }
          : { name: "HTML", extensions: ["html"] }
    ]
  };
}

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 80);
  return normalized || "codex-session";
}

export function registerSessionIpcHandlers() {
  ipcMain.handle("codex:list-cached-targets", (_event, providerId: unknown) =>
    listCachedTargets(providerId === undefined || providerId === null || providerId === "" ? undefined : requireProviderId(providerId))
  );
  ipcMain.handle("codex:list-cached-sessions", (_event, targetId: unknown, view: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedView = requireView(view);
    return coalesceSessionRequest(`cached:${checkedTargetId}:${checkedView}`, () =>
      listCachedSessions(checkedTargetId, checkedView)
    );
  });
  ipcMain.handle("codex:list-targets", (_event, providerId: unknown) =>
    listTargets(providerId === undefined || providerId === null || providerId === "" ? undefined : requireProviderId(providerId))
  );
  ipcMain.handle("codex:list-sessions", (_event, targetId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    return coalesceSessionRequest(`list:${checkedTargetId}:active`, () => listSessions(checkedTargetId));
  });
  ipcMain.handle("codex:list-trash-sessions", (_event, targetId: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    return coalesceSessionRequest(`list:${checkedTargetId}:trash`, () => listTrashSessions(checkedTargetId));
  });
  ipcMain.handle("codex:search-sessions", (_event, targetId: unknown, view: unknown, query: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedView = requireView(view);
    const checkedQuery = requireString(query, "query");
    return coalesceSessionRequest(`search:${checkedTargetId}:${checkedView}:${checkedQuery}`, () =>
      searchSessions(checkedTargetId, checkedView, checkedQuery)
    );
  });
  ipcMain.handle("codex:get-session", (_event, targetId: unknown, sessionId: unknown, refValue: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const checkedSessionId = requireString(sessionId, "sessionId");
    const ref = requireSessionFileRef(refValue);
    return coalesceSessionRequest(`get:${checkedTargetId}:${checkedSessionId}:${ref?.filePath || ""}`, () =>
      getSession(checkedTargetId, checkedSessionId, ref)
    );
  });
  ipcMain.handle("codex:get-session-messages-page", (_event, targetId: unknown, sessionId: unknown, offset: unknown, limit: unknown) =>
    getSessionMessagesPage(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireMessagePageOffset(offset),
      Math.min(requirePositiveInteger(limit, "limit"), 500)
    )
  );
  ipcMain.handle("codex:get-session-summary", (_event, targetId: unknown, sessionId: unknown) =>
    getSessionSummary(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"))
  );
  ipcMain.handle("codex:set-session-custom-title", (_event, targetId: unknown, sessionId: unknown, title: unknown) =>
    setSessionCustomTitle(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireCustomTitle(title)
    )
  );
  ipcMain.handle("codex:list-session-children", (_event, targetId: unknown, parentSessionId: unknown) =>
    listSessionsByParent(requireString(targetId, "targetId"), requireString(parentSessionId, "parentSessionId"))
  );
  ipcMain.handle("codex:export-session", async (event, targetId: unknown, sessionId: unknown, format: unknown) => {
    const checkedFormat = requireExportFormat(format);
    const session = await getSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"));
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showSaveDialog(owner, exportDialogOptions(session.title, checkedFormat))
      : await dialog.showSaveDialog(exportDialogOptions(session.title, checkedFormat));
    if (result.canceled || !result.filePath) return null;
    return exportSessionToFile(session, checkedFormat, result.filePath);
  });
  ipcMain.handle(
    "codex:branch-session",
    (_event, targetId: unknown, sessionId: unknown, messageIndex: unknown) =>
      branchSession(
        requireString(targetId, "targetId"),
        requireString(sessionId, "sessionId"),
        requireNonNegativeInteger(messageIndex, "messageIndex")
      )
  );
  ipcMain.handle("codex:duplicate-session", (_event, targetId: unknown, sessionId: unknown, title: unknown) =>
    duplicateSession(
      requireString(targetId, "targetId"),
      requireString(sessionId, "sessionId"),
      requireCustomTitle(title)
    )
  );
  ipcMain.handle("codex:delete-session", (_event, targetId: unknown, sessionId: unknown, ref: unknown) =>
    deleteSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"), requireSessionFileRef(ref))
  );
  ipcMain.handle("codex:delete-sessions", (_event, targetId: unknown, sessions: unknown) =>
    deleteSessions(requireString(targetId, "targetId"), requireSessionMutationRefs(sessions))
  );
  ipcMain.handle("codex:restore-session", (_event, targetId: unknown, sessionId: unknown) =>
    restoreSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"))
  );
  ipcMain.handle("codex:purge-session", (_event, targetId: unknown, sessionId: unknown, ref: unknown) =>
    purgeSession(requireString(targetId, "targetId"), requireString(sessionId, "sessionId"), requireSessionFileRef(ref))
  );
  ipcMain.handle("codex:purge-sessions", (_event, targetId: unknown, sessions: unknown) =>
    purgeSessions(requireString(targetId, "targetId"), requireSessionMutationRefs(sessions))
  );
  ipcMain.handle("codex:set-wsl-codex-home", (_event, distro: unknown, codexHome: unknown) =>
    setWslCodexHome(requireString(distro, "distro"), requireString(codexHome, "codexHome"))
  );
  ipcMain.handle("codex:clear-wsl-codex-home", (_event, distro: unknown) =>
    clearWslCodexHome(requireString(distro, "distro"))
  );
}
