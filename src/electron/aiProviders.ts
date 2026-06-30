import type {
  AiProviderCapabilities,
  AiProviderId,
  AiProviderSummary,
  AiSession,
  AiTarget,
  SessionBatchMutationResult,
  SessionFileRef,
  SessionMutationRef
} from "./types";
import * as codexTargets from "./codexTargets";
import * as geminiProvider from "./geminiProvider";
import * as claudeProvider from "./claudeProvider";

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
  getSession: (targetId: string, sessionId: string) => Promise<AiSession>;
  listSessionsByParent: (targetId: string, parentSessionId: string) => Promise<AiSession[]>;
  getSessionFolderPath: (targetId: string, sessionId: string) => Promise<string>;
  branchSession: (targetId: string, sessionId: string, messageIndex: number) => Promise<AiSession>;
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
    sessionSettings: true
  },
  listCachedTargets: codexTargets.listCachedTargets,
  listTargets: codexTargets.listTargets,
  listCachedSessions: codexTargets.listCachedSessions,
  listSessions: codexTargets.listSessions,
  listTrashSessions: codexTargets.listTrashSessions,
  searchSessions: codexTargets.searchSessions,
  getSession: codexTargets.getSession,
  listSessionsByParent: codexTargets.listSessionsByParent,
  getSessionFolderPath: codexTargets.getSessionFolderPath,
  branchSession: codexTargets.branchSession,
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
    sessionSettings: false
  },
  listCachedTargets: geminiProvider.listCachedTargets,
  listTargets: geminiProvider.listTargets,
  listCachedSessions: geminiProvider.listCachedSessions,
  listSessions: geminiProvider.listSessions,
  listTrashSessions: geminiProvider.listTrashSessions,
  searchSessions: geminiProvider.searchSessions,
  getSession: geminiProvider.getSession,
  listSessionsByParent: geminiProvider.listSessionsByParent,
  getSessionFolderPath: geminiProvider.getSessionFolderPath,
  branchSession: geminiProvider.branchSession,
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
    sessionSettings: false
  },
  listCachedTargets: claudeProvider.listCachedTargets,
  listTargets: claudeProvider.listTargets,
  listCachedSessions: claudeProvider.listCachedSessions,
  listSessions: claudeProvider.listSessions,
  listTrashSessions: claudeProvider.listTrashSessions,
  searchSessions: claudeProvider.searchSessions,
  getSession: claudeProvider.getSession,
  listSessionsByParent: claudeProvider.listSessionsByParent,
  getSessionFolderPath: claudeProvider.getSessionFolderPath,
  branchSession: claudeProvider.branchSession,
  deleteSession: claudeProvider.deleteSession,
  deleteSessions: claudeProvider.deleteSessions,
  restoreSession: claudeProvider.restoreSession,
  purgeSession: claudeProvider.purgeSession,
  purgeSessions: claudeProvider.purgeSessions
};

const providers: AiProvider[] = [codexProvider, geminiAiProvider, claudeAiProvider];

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

export function getSession(targetId: string, sessionId: string) {
  return getProviderForTarget(targetId).getSession(targetId, sessionId);
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

export function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return getProviderForTarget(targetId).deleteSession(targetId, sessionId, ref);
}

export function deleteSessions(targetId: string, sessions: SessionMutationRef[]) {
  return getProviderForTarget(targetId).deleteSessions(targetId, sessions);
}

export function restoreSession(targetId: string, sessionId: string) {
  return getProviderForTarget(targetId).restoreSession(targetId, sessionId);
}

export function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return getProviderForTarget(targetId).purgeSession(targetId, sessionId, ref);
}

export function purgeSessions(targetId: string, sessions: SessionMutationRef[]) {
  return getProviderForTarget(targetId).purgeSessions(targetId, sessions);
}

export const setWslCodexHome = codexTargets.setWslCodexHome;
export const clearWslCodexHome = codexTargets.clearWslCodexHome;

function getProviderIdFromTargetId(targetId: string): AiProviderId {
  if (targetId.startsWith("gemini:")) return "gemini";
  if (targetId.startsWith("claude:")) return "claude";
  if (targetId.startsWith("codex:")) return "codex";
  return "codex";
}
