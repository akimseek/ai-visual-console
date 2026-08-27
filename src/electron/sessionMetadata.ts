import fs from "node:fs/promises";
import type { CodexSession, SessionBranchMetadata, SessionMetadata } from "./types";
import {
  deleteSessionMetadataRecord,
  hasAppDatabase,
  importSessionMetadata,
  readSessionIdsByParent,
  readSessionMetadata,
  readSessionMetadataMap,
  saveSessionMetadata
} from "./appDatabase";

type MetadataStore = {
  version: number;
  sessions: Record<string, SessionMetadata>;
};

const STORE_VERSION = 1;
let metadataPath = "";
let migrationPromise: Promise<void> | null = null;

export function setSessionMetadataPath(filePath: string) {
  metadataPath = filePath;
  migrationPromise = null;
}

export async function applySessionMetadata(targetId: string, session: CodexSession): Promise<CodexSession> {
  if (!hasAppDatabase()) return session;
  await ensureLegacyMetadataMigrated();
  const metadata = await readSessionMetadata(targetId, session.id);
  return attachMetadata(session, metadata);
}

export async function applySessionMetadataList(targetId: string, sessions: CodexSession[]): Promise<CodexSession[]> {
  if (!hasAppDatabase()) return sessions;
  await ensureLegacyMetadataMigrated();
  const metadata = await readSessionMetadataMap(targetId);
  return sessions.map((session) => attachMetadata(session, metadata[session.id]));
}

export async function findSessionIdsByParent(targetId: string, parentSessionId: string): Promise<string[] | null> {
  if (!hasAppDatabase()) return null;
  await ensureLegacyMetadataMigrated();
  return readSessionIdsByParent(targetId, parentSessionId);
}

export async function setSessionBranchMetadata(
  targetId: string,
  sessionId: string,
  branch: SessionBranchMetadata
): Promise<SessionMetadata> {
  await ensureLegacyMetadataMigrated();
  const current = await readSessionMetadata(targetId, sessionId);
  const next = normalizeMetadata({
    ...current,
    branch: normalizeBranch(branch),
    updatedAt: new Date().toISOString()
  });
  await saveSessionMetadata(targetId, sessionId, next);
  return next;
}

export async function setSessionCustomTitle(
  targetId: string,
  sessionId: string,
  customTitle: string
): Promise<SessionMetadata> {
  await ensureLegacyMetadataMigrated();
  const current = await readSessionMetadata(targetId, sessionId);
  const next = normalizeMetadata({
    ...current,
    customTitle,
    updatedAt: new Date().toISOString()
  });
  if (isEmptyMetadata(next)) {
    await deleteSessionMetadataRecord(targetId, sessionId);
    return next;
  }
  await saveSessionMetadata(targetId, sessionId, next);
  return next;
}

export async function deleteSessionMetadata(targetId: string, sessionId: string) {
  await ensureLegacyMetadataMigrated();
  await deleteSessionMetadataRecord(targetId, sessionId);
}

function attachMetadata(session: CodexSession, metadata?: SessionMetadata): CodexSession {
  const normalized = normalizeMetadata(metadata || {});
  if (isEmptyMetadata(normalized)) return session;
  const sourceTitle = session.sourceTitle || session.title;
  return {
    ...session,
    title: normalized.customTitle || sourceTitle,
    sourceTitle,
    metadata: normalized
  };
}

function normalizeMetadata(metadata: SessionMetadata): SessionMetadata {
  return {
    customTitle: normalizeCustomTitle(metadata.customTitle),
    branch: normalizeBranch(metadata.branch),
    updatedAt: metadata.updatedAt
  };
}

function normalizeCustomTitle(value?: string) {
  const title = value?.trim();
  return title ? title : undefined;
}

function normalizeBranch(branch?: SessionBranchMetadata): SessionBranchMetadata | undefined {
  if (!branch?.parentSessionId) return undefined;
  return {
    parentTargetId: branch.parentTargetId,
    parentSessionId: branch.parentSessionId,
    parentMessageIndex:
      typeof branch.parentMessageIndex === "number" && Number.isInteger(branch.parentMessageIndex)
        ? branch.parentMessageIndex
        : undefined,
    createdBy: branch.createdBy === "manual" ? "manual" : "branch"
  };
}

function isEmptyMetadata(metadata: SessionMetadata) {
  return !metadata.customTitle && !metadata.branch;
}

async function readLegacyStore(): Promise<MetadataStore> {
  if (!metadataPath) return emptyStore();
  try {
    const store = JSON.parse(await fs.readFile(metadataPath, "utf8")) as MetadataStore;
    if (store.version !== STORE_VERSION || !store.sessions) return emptyStore();
    return store;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyStore();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[legacy-metadata-read-failed] ${message}`, error);
    await backupBrokenStore(error);
    return emptyStore();
  }
}

async function ensureLegacyMetadataMigrated() {
  if (!migrationPromise) migrationPromise = migrateLegacyMetadata();
  await migrationPromise;
}

async function migrateLegacyMetadata() {
  const store = await readLegacyStore();
  const entries = Object.entries(store.sessions).flatMap(([key, metadata]) => {
    const identity = parseLegacyMetadataKey(key);
    return identity ? [{ ...identity, metadata: normalizeMetadata(metadata) }] : [];
  });
  await importSessionMetadata(entries);
  if (!metadataPath || entries.length === 0) return;
  await fs.rename(metadataPath, `${metadataPath}.migrated`).catch(() => undefined);
}

function parseLegacyMetadataKey(key: string) {
  try {
    const value = JSON.parse(key) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [targetId, sessionId] = value;
    return typeof targetId === "string" && typeof sessionId === "string" ? { targetId, sessionId } : null;
  } catch {
    return null;
  }
}

function emptyStore(): MetadataStore {
  return { version: STORE_VERSION, sessions: {} };
}

async function backupBrokenStore(error: unknown) {
  if (!metadataPath || (error as NodeJS.ErrnoException)?.code === "ENOENT") return;
  const backupPath = `${metadataPath}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.copyFile(metadataPath, backupPath);
  } catch {
    // 元数据损坏不能阻止会话浏览。
  }
}
