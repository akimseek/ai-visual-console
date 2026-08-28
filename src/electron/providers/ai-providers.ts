import type {
  AiProviderCapabilities,
  AiProviderId,
  AiProviderSummary,
  AiSession,
  AiTarget,
  SessionBatchMutationResult,
  SessionFileRef,
  SessionMessagePage,
  SessionMutationRef
} from "../types";
import * as codexTargets from "./codex/codex-targets";
import * as geminiProvider from "./gemini/gemini-provider";
import * as claudeProvider from "./claude/claude-provider";
import * as qoderProvider from "./qoder/qoder-provider";
import { applySessionMetadata, deleteSessionMetadata, setSessionCustomTitle } from "./session-metadata";

export type SessionView = "active" | "trash";

export type AiProvider = {
  id: AiProviderId;
  label: string;
  capabilities: AiProviderCapabilities;
  listCachedTargets: () => Promise<AiTarget[]>;
  listTargets: () => Promise<AiTarget[]>;
  listCachedSessions: (targetId: string, view: SessionView) => Promise<AiSession[]>;
  listSessions: (targetId: string) => Promise<AiSession[]>;
  listTrashSessions: (targetId: string) => Promise<AiSession[]>;
  searchSessions: (targetId: string, view: SessionView, query: string) => Promise<AiSession[]>;
  getSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<AiSession>;
  getSessionMessagesPage: (targetId: string, sessionId: string, offset: number, limit: number) => Promise<SessionMessagePage>;
  getSessionSummary: (targetId: string, sessionId: string) => Promise<AiSession>;
  listSessionsByParent: (targetId: string, parentSessionId: string) => Promise<AiSession[]>;
  getSessionFolderPath: (targetId: string, sessionId: string) => Promise<string>;
  branchSession: (targetId: string, sessionId: string, messageIndex: number) => Promise<AiSession>;
  duplicateSession: (targetId: string, sessionId: string) => Promise<AiSession>;
  deleteSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<{ movedTo: string }>;
  deleteSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
  restoreSession: (targetId: string, sessionId: string) => Promise<{ restoredTo: string }>;
  purgeSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<{ deleted: string }>;
  purgeSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
};

const codexProvider: AiProvider = {
  id: "codex",
  label: "Codex",
  capabilities: {
    skills: true,
    branch: true,
    usage: true,
    trash: true,
    batchActions: true,
    customCwd: true,
    export: true,
    sessionSettings: true,
    duplicate: true,
    vendorManagement: true
  },
  listCachedTargets: codexTargets.listCachedTargets,
  listTargets: codexTargets.listTargets,
  listCachedSessions: codexTargets.listCachedSessions,
  listSessions: codexTargets.listSessions,
  listTrashSessions: codexTargets.listTrashSessions,
  searchSessions: codexTargets.searchSessions,
  getSession: codexTargets.getSession,
  getSessionMessagesPage: codexTargets.getSessionMessagesPage,
  getSessionSummary: codexTargets.getSessionSummary,
  listSessionsByParent: codexTargets.listSessionsByParent,
  getSessionFolderPath: codexTargets.getSessionFolderPath,
  branchSession: codexTargets.branchSession,
  duplicateSession: codexTargets.duplicateSession,
  deleteSession: codexTargets.deleteSession,
  deleteSessions: codexTargets.deleteSessions,
  restoreSession: codexTargets.restoreSession,
  purgeSession: codexTargets.purgeSession,
  purgeSessions: codexTargets.purgeSessions
};

const geminiAiProvider: AiProvider = {
  id: "gemini",
  label: "Gemini",
  capabilities: {
    skills: false,
    branch: true,
    usage: true,
    trash: true,
    batchActions: true,
    customCwd: true,
    export: true,
    sessionSettings: false,
    duplicate: true,
    vendorManagement: true
  },
  listCachedTargets: geminiProvider.listCachedTargets,
  listTargets: geminiProvider.listTargets,
  listCachedSessions: geminiProvider.listCachedSessions,
  listSessions: geminiProvider.listSessions,
  listTrashSessions: geminiProvider.listTrashSessions,
  searchSessions: geminiProvider.searchSessions,
  getSession: geminiProvider.getSession,
  getSessionMessagesPage: geminiProvider.getSessionMessagesPage,
  getSessionSummary: geminiProvider.getSessionSummary,
  listSessionsByParent: geminiProvider.listSessionsByParent,
  getSessionFolderPath: geminiProvider.getSessionFolderPath,
  branchSession: geminiProvider.branchSession,
  duplicateSession: geminiProvider.duplicateSession,
  deleteSession: geminiProvider.deleteSession,
  deleteSessions: geminiProvider.deleteSessions,
  restoreSession: geminiProvider.restoreSession,
  purgeSession: geminiProvider.purgeSession,
  purgeSessions: geminiProvider.purgeSessions
};

const claudeAiProvider: AiProvider = {
  id: "claude",
  label: "Claude Code",
  capabilities: {
    skills: false,
    branch: true,
    usage: true,
    trash: true,
    batchActions: true,
    customCwd: true,
    export: true,
    sessionSettings: false,
    duplicate: true,
    vendorManagement: true
  },
  listCachedTargets: claudeProvider.listCachedTargets,
  listTargets: claudeProvider.listTargets,
  listCachedSessions: claudeProvider.listCachedSessions,
  listSessions: claudeProvider.listSessions,
  listTrashSessions: claudeProvider.listTrashSessions,
  searchSessions: claudeProvider.searchSessions,
  getSession: claudeProvider.getSession,
  getSessionMessagesPage: claudeProvider.getSessionMessagesPage,
  getSessionSummary: claudeProvider.getSessionSummary,
  listSessionsByParent: claudeProvider.listSessionsByParent,
  getSessionFolderPath: claudeProvider.getSessionFolderPath,
  branchSession: claudeProvider.branchSession,
  duplicateSession: claudeProvider.duplicateSession,
  deleteSession: claudeProvider.deleteSession,
  deleteSessions: claudeProvider.deleteSessions,
  restoreSession: claudeProvider.restoreSession,
  purgeSession: claudeProvider.purgeSession,
  purgeSessions: claudeProvider.purgeSessions
};

const qoderAiProvider: AiProvider = {
  id: "qoder",
  label: "Qoder CN",
  capabilities: {
    skills: false,
    branch: false,
    usage: true,
    trash: true,
    batchActions: true,
    customCwd: true,
    export: true,
    sessionSettings: false,
    duplicate: false,
    vendorManagement: false
  },
  listCachedTargets: qoderProvider.listCachedTargets,
  listTargets: qoderProvider.listTargets,
  listCachedSessions: qoderProvider.listCachedSessions,
  listSessions: qoderProvider.listSessions,
  listTrashSessions: qoderProvider.listTrashSessions,
  searchSessions: qoderProvider.searchSessions,
  getSession: qoderProvider.getSession,
  getSessionMessagesPage: qoderProvider.getSessionMessagesPage,
  getSessionSummary: qoderProvider.getSessionSummary,
  listSessionsByParent: qoderProvider.listSessionsByParent,
  getSessionFolderPath: qoderProvider.getSessionFolderPath,
  branchSession: qoderProvider.branchSession,
  duplicateSession: qoderProvider.duplicateSession,
  deleteSession: qoderProvider.deleteSession,
  deleteSessions: qoderProvider.deleteSessions,
  restoreSession: qoderProvider.restoreSession,
  purgeSession: qoderProvider.purgeSession,
  purgeSessions: qoderProvider.purgeSessions
};

const providers: AiProvider[] = [codexProvider, geminiAiProvider, claudeAiProvider, qoderAiProvider];

export function listAiProviders() {
  return providers;
}

export function listProviderSummaries(): AiProviderSummary[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: provider.capabilities
  }));
}

export function getProvider(providerId: AiProviderId) {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(`未知 AI 平台：${providerId}`);
  return provider;
}

export function getProviderForTarget(targetId: string) {
  return getProvider(getProviderIdFromTargetId(targetId));
}

export async function listCachedTargets(providerId?: AiProviderId) {
  if (providerId) return getProvider(providerId).listCachedTargets();
  const targets = await Promise.all(providers.map((provider) => provider.listCachedTargets()));
  return targets.flat();
}

export async function listTargets(providerId?: AiProviderId) {
  if (providerId) return getProvider(providerId).listTargets();
  const targets = await Promise.all(providers.map((provider) => provider.listTargets()));
  return targets.flat();
}

export function listCachedSessions(targetId: string, view: SessionView) {
  return getProviderForTarget(targetId).listCachedSessions(targetId, view);
}

export function listSessions(targetId: string) {
  return getProviderForTarget(targetId).listSessions(targetId);
}

export function listTrashSessions(targetId: string) {
  return getProviderForTarget(targetId).listTrashSessions(targetId);
}

export function searchSessions(targetId: string, view: SessionView, query: string) {
  return getProviderForTarget(targetId).searchSessions(targetId, view, query);
}

export function getSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return getProviderForTarget(targetId).getSession(targetId, sessionId, ref);
}

export function getSessionMessagesPage(targetId: string, sessionId: string, offset: number, limit: number) {
  return getProviderForTarget(targetId).getSessionMessagesPage(targetId, sessionId, offset, limit);
}

export function getSessionSummary(targetId: string, sessionId: string) {
  return getProviderForTarget(targetId).getSessionSummary(targetId, sessionId);
}

export function listSessionsByParent(targetId: string, parentSessionId: string) {
  return getProviderForTarget(targetId).listSessionsByParent(targetId, parentSessionId);
}

export function getSessionFolderPath(targetId: string, sessionId: string) {
  return getProviderForTarget(targetId).getSessionFolderPath(targetId, sessionId);
}

export function branchSession(targetId: string, sessionId: string, messageIndex: number) {
  return getProviderForTarget(targetId).branchSession(targetId, sessionId, messageIndex);
}

export async function duplicateSession(targetId: string, sessionId: string, title = "") {
  const duplicated = await getProviderForTarget(targetId).duplicateSession(targetId, sessionId);
  if (!title.trim()) return duplicated;
  await setSessionCustomTitle(targetId, duplicated.id, title);
  return applySessionMetadata(targetId, duplicated);
}

export function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return getProviderForTarget(targetId).deleteSession(targetId, sessionId, ref);
}

export function deleteSessions(targetId: string, sessions: SessionMutationRef[]) {
  return getProviderForTarget(targetId).deleteSessions(targetId, sessions);
}

export function restoreSession(targetId: string, sessionId: string) {
  return getProviderForTarget(targetId).restoreSession(targetId, sessionId);
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  const result = await getProviderForTarget(targetId).purgeSession(targetId, sessionId, ref);
  await deleteSessionMetadata(targetId, sessionId).catch(() => undefined);
  return result;
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]) {
  const result = await getProviderForTarget(targetId).purgeSessions(targetId, sessions);
  await Promise.all(result.processed.map((session) => deleteSessionMetadata(targetId, session.id).catch(() => undefined)));
  return result;
}

export const setWslCodexHome = codexTargets.setWslCodexHome;
export const clearWslCodexHome = codexTargets.clearWslCodexHome;

function getProviderIdFromTargetId(targetId: string): AiProviderId {
  if (targetId.startsWith("gemini:")) return "gemini";
  if (targetId.startsWith("claude:")) return "claude";
  if (targetId.startsWith("qoder:")) return "qoder";
  if (targetId.startsWith("codex:")) return "codex";
  return "codex";
}
