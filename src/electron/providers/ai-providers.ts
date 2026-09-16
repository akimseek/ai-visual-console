import type {
  AiProviderCapabilities,
  AiProviderId,
  AiProviderSummary,
  AiSession,
  AiTarget,
  SessionQuickAccess,
  SessionQuickAccessItem,
  SessionBatchMutationResult,
  SessionFileRef,
  SessionMessagePage,
  SessionMutationRef
} from "../types";
import * as codexTargets from "./codex/codex-targets";
import * as geminiProvider from "./gemini/gemini-provider";
import * as claudeProvider from "./claude/claude-provider";
import * as qoderProvider from "./qoder/qoder-provider";
import { getProviderIdFromTargetId } from "../../shared/target-ids";
import {
  applySessionMetadata,
  deleteSessionMetadata,
  listSessionQuickMetadata,
  markSessionOpened,
  setSessionCustomTitle,
  setSessionFavorite
} from "./session-metadata";

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
  deleteSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<import("../../shared/types").SessionDeleteResult>;
  deleteSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
  restoreSession: (targetId: string, sessionId: string) => Promise<{ restoredTo: string }>;
  purgeSession: (targetId: string, sessionId: string, ref?: SessionFileRef) => Promise<{ deleted: string }>;
  purgeSessions: (targetId: string, sessions: SessionMutationRef[]) => Promise<SessionBatchMutationResult>;
};

// provider 实现模块的公共形状：AiProvider 去掉静态描述字段后的全部会话操作。
type AiProviderModule = Omit<AiProvider, "id" | "label" | "capabilities">;

type ProviderDefinition = {
  id: AiProviderId;
  label: string;
  capabilities: AiProviderCapabilities;
  module: AiProviderModule;
};

function createAiProvider({ id, label, capabilities, module }: ProviderDefinition): AiProvider {
  return { id, label, capabilities, ...module };
}

// 新增 Provider 只需要在这里声明静态信息和实现模块，避免注册逻辑分散到多个分支。
const providerDefinitions = [
  {
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
    module: codexTargets
  },
  {
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
    module: geminiProvider
  },
  {
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
    module: claudeProvider
  },
  {
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
    module: qoderProvider
  }
] satisfies readonly ProviderDefinition[];

const providers: AiProvider[] = providerDefinitions.map(createAiProvider);

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
  return listAcrossProviders((provider) => provider.listCachedTargets());
}

export async function listTargets(providerId?: AiProviderId) {
  if (providerId) return getProvider(providerId).listTargets();
  return listAcrossProviders((provider) => provider.listTargets());
}

const MAX_QUICK_ACCESS_FAVORITES = 12;
const MAX_QUICK_ACCESS_RECENT = 8;

export async function listSessionQuickAccess(): Promise<SessionQuickAccess> {
  const entries = await listSessionQuickMetadata();
  const candidates = entries.filter((entry) => entry.metadata.favorite || entry.metadata.lastOpenedAt);
  if (candidates.length === 0) return { favorites: [], recent: [] };

  const targets = await listCachedTargets();
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  const candidatesByTarget = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!targetsById.has(candidate.targetId)) continue;
    const group = candidatesByTarget.get(candidate.targetId) || [];
    group.push(candidate);
    candidatesByTarget.set(candidate.targetId, group);
  }

  const groups = await Promise.all([...candidatesByTarget.entries()].map(async ([targetId, targetCandidates]) => {
    const sessions = await listCachedSessions(targetId, "active").catch(() => [] as AiSession[]);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const target = targetsById.get(targetId)!;
    return targetCandidates.flatMap((candidate): SessionQuickAccessItem[] => {
      const session = sessionsById.get(candidate.sessionId);
      return session ? [{
        target,
        session,
        favorite: candidate.metadata.favorite === true,
        lastOpenedAt: candidate.metadata.lastOpenedAt
      }] : [];
    });
  }));

  const items = groups.flat();
  const favorites = items
    .filter((item) => item.favorite)
    .sort(compareQuickAccessItems)
    .slice(0, MAX_QUICK_ACCESS_FAVORITES);
  const favoriteKeys = new Set(favorites.map(quickAccessKey));
  const recent = items
    .filter((item) => item.lastOpenedAt && !favoriteKeys.has(quickAccessKey(item)))
    .sort(compareQuickAccessItems)
    .slice(0, MAX_QUICK_ACCESS_RECENT);
  return { favorites, recent };
}

export function setSessionFavoriteForTarget(targetId: string, sessionId: string, favorite: boolean) {
  return setSessionFavorite(targetId, sessionId, favorite);
}

export function markSessionOpenedForTarget(targetId: string, sessionId: string) {
  return markSessionOpened(targetId, sessionId);
}

function compareQuickAccessItems(left: SessionQuickAccessItem, right: SessionQuickAccessItem) {
  return Date.parse(right.lastOpenedAt || right.session.updatedAt || right.session.createdAt || "")
    - Date.parse(left.lastOpenedAt || left.session.updatedAt || left.session.createdAt || "")
    || left.target.label.localeCompare(right.target.label)
    || left.session.title.localeCompare(right.session.title);
}

function quickAccessKey(item: SessionQuickAccessItem) {
  return `${item.target.id}:${item.session.id}`;
}

async function listAcrossProviders<T>(operation: (provider: AiProvider) => Promise<T[]>) {
  const values = await Promise.all(providers.map(operation));
  return values.flat();
}

function dispatchToTarget<T>(targetId: string, operation: (provider: AiProvider) => Promise<T>) {
  return operation(getProviderForTarget(targetId));
}

export function listCachedSessions(targetId: string, view: SessionView) {
  return dispatchToTarget(targetId, (provider) => provider.listCachedSessions(targetId, view));
}

export function listSessions(targetId: string) {
  return dispatchToTarget(targetId, (provider) => provider.listSessions(targetId));
}

export function listTrashSessions(targetId: string) {
  return dispatchToTarget(targetId, (provider) => provider.listTrashSessions(targetId));
}

export function searchSessions(targetId: string, view: SessionView, query: string) {
  return dispatchToTarget(targetId, (provider) => provider.searchSessions(targetId, view, query));
}

export function getSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return dispatchToTarget(targetId, (provider) => provider.getSession(targetId, sessionId, ref));
}

export function getSessionMessagesPage(targetId: string, sessionId: string, offset: number, limit: number) {
  return dispatchToTarget(targetId, (provider) => provider.getSessionMessagesPage(targetId, sessionId, offset, limit));
}

export function getSessionSummary(targetId: string, sessionId: string) {
  return dispatchToTarget(targetId, (provider) => provider.getSessionSummary(targetId, sessionId));
}

export function listSessionsByParent(targetId: string, parentSessionId: string) {
  return dispatchToTarget(targetId, (provider) => provider.listSessionsByParent(targetId, parentSessionId));
}

export function getSessionFolderPath(targetId: string, sessionId: string) {
  return dispatchToTarget(targetId, (provider) => provider.getSessionFolderPath(targetId, sessionId));
}

export function branchSession(targetId: string, sessionId: string, messageIndex: number) {
  return dispatchToTarget(targetId, (provider) => provider.branchSession(targetId, sessionId, messageIndex));
}

export async function duplicateSession(targetId: string, sessionId: string, title = "") {
  const duplicated = await dispatchToTarget(targetId, (provider) => provider.duplicateSession(targetId, sessionId));
  if (!title.trim()) return duplicated;
  await setSessionCustomTitle(targetId, duplicated.id, title);
  return applySessionMetadata(targetId, duplicated);
}

export function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return dispatchToTarget(targetId, (provider) => provider.deleteSession(targetId, sessionId, ref));
}

export function deleteSessions(targetId: string, sessions: SessionMutationRef[]) {
  return dispatchToTarget(targetId, (provider) => provider.deleteSessions(targetId, sessions));
}

export function restoreSession(targetId: string, sessionId: string) {
  return dispatchToTarget(targetId, (provider) => provider.restoreSession(targetId, sessionId));
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  const result = await dispatchToTarget(targetId, (provider) => provider.purgeSession(targetId, sessionId, ref));
  await deleteSessionMetadata(targetId, sessionId).catch(() => undefined);
  return result;
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]) {
  const result = await dispatchToTarget(targetId, (provider) => provider.purgeSessions(targetId, sessions));
  await Promise.all(result.processed.map((session) => deleteSessionMetadata(targetId, session.id).catch(() => undefined)));
  return result;
}

export const setWslCodexHome = codexTargets.setWslCodexHome;
export const clearWslCodexHome = codexTargets.clearWslCodexHome;
