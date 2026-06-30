import fs from "node:fs/promises";
import path from "node:path";
import type { CodexSession, SessionBranchMetadata, SessionMetadata } from "./types";

type MetadataStore = {
  version: number;
  sessions: Record<string, SessionMetadata>;
};

const STORE_VERSION = 1;
let metadataPath = "";
let metadataQueue = Promise.resolve();

export function setSessionMetadataPath(filePath: string) {
  metadataPath = filePath;
}

export async function applySessionMetadata(targetId: string, session: CodexSession): Promise<CodexSession> {
  const metadata = await getSessionMetadata(targetId, session.id);
  return attachMetadata(session, metadata);
}

export async function applySessionMetadataList(targetId: string, sessions: CodexSession[]): Promise<CodexSession[]> {
  const store = await readStore();
  return sessions.map((session) => attachMetadata(session, store.sessions[metadataKey(targetId, session.id)]));
}

export async function setSessionBranchMetadata(
  targetId: string,
  sessionId: string,
  branch: SessionBranchMetadata
): Promise<SessionMetadata> {
  return updateStore((store) => {
    const key = metadataKey(targetId, sessionId);
    const current = store.sessions[key] || {};
    const next = normalizeMetadata({
      ...current,
      branch: normalizeBranch(branch),
      updatedAt: new Date().toISOString()
    });

    store.sessions[key] = next;
    return { store, metadata: next };
  });
}

async function getSessionMetadata(targetId: string, sessionId: string): Promise<SessionMetadata> {
  const store = await readStore();
  return store.sessions[metadataKey(targetId, sessionId)] || {};
}

function attachMetadata(session: CodexSession, metadata?: SessionMetadata): CodexSession {
  const normalized = normalizeMetadata(metadata || {});
  return isEmptyMetadata(normalized) ? session : { ...session, metadata: normalized };
}

function normalizeMetadata(metadata: SessionMetadata): SessionMetadata {
  return {
    branch: normalizeBranch(metadata.branch),
    updatedAt: metadata.updatedAt
  };
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
  return !metadata.branch;
}

function metadataKey(targetId: string, sessionId: string) {
  return JSON.stringify([targetId, sessionId]);
}

async function readStore(): Promise<MetadataStore> {
  if (!metadataPath) return emptyStore();
  try {
    const store = JSON.parse(await fs.readFile(metadataPath, "utf8")) as MetadataStore;
    if (store.version !== STORE_VERSION || !store.sessions) return emptyStore();
    return store;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyStore();
    await backupBrokenStore(error);
    return emptyStore();
  }
}

async function updateStore(updater: (store: MetadataStore) => { store: MetadataStore; metadata: SessionMetadata }) {
  if (!metadataPath) return {};

  let result: SessionMetadata = {};
  metadataQueue = metadataQueue.catch(() => undefined).then(async () => {
    const next = updater(await readStore());
    result = next.metadata;
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(next.store, null, 2), "utf8");
    await fs.rename(tempPath, metadataPath);
  });
  await metadataQueue;
  return result;
}

function emptyStore(): MetadataStore {
  return { version: STORE_VERSION, sessions: {} };
}

async function backupBrokenStore(error: any) {
  if (!metadataPath || error?.code === "ENOENT") return;
  const backupPath = `${metadataPath}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.copyFile(metadataPath, backupPath);
  } catch {
    // 元数据损坏不能阻止会话浏览。
  }
}
