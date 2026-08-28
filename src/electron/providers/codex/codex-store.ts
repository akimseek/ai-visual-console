import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
import type { CodexSession, CodexSessionFile, SessionMutationRef } from "../../types";
import { parseSessionContent, parseSessionListContent } from "../../../shared/session-parser";
import {
  readSessionCache,
  removeSessionCacheEntries,
  replaceSessionCache,
  setSessionDatabasePath as configureSessionDatabase,
  type SessionCacheEntry
} from "../../core/app-database";

const SESSION_FILE_RE = /^rollout-.+\.jsonl$/;
const CACHE_VERSION = 5;
const LIST_READ_BYTES = 64 * 1024;
const MAX_SESSION_READ_BYTES = 32 * 1024 * 1024;
const LIST_PARSE_CONCURRENCY = 16;
let sessionCacheRoot = process.env.CODEX_VISUAL_CONSOLE_CACHE_DIR || path.join(os.homedir(), ".codex-visual-console-cache");
let sessionCacheDatabasePath = "";
const cacheWriteQueues = new Map<string, Promise<void>>();

type SessionCache = {
  version: number;
  sessions: Record<string, CachedSession>;
};

type CachedSession = {
  mtimeMs: number;
  size: number;
  session: CodexSession;
};

export function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function getTrashRoot() {
  return path.join(getCodexHome(), ".visual-console-trash");
}

export function getCachePath() {
  return path.join(sessionCacheRoot, "sessions.json");
}

export function getTrashCachePath() {
  return path.join(sessionCacheRoot, "sessions-trash.json");
}

export function setSessionCacheRoot(cacheRoot: string) {
  sessionCacheRoot = cacheRoot;
}

export function setSessionDatabasePath(databasePath: string) {
  sessionCacheDatabasePath = databasePath;
  configureSessionDatabase(databasePath);
}

export async function listSessions(): Promise<CodexSession[]> {
  const sessionsRoot = path.join(getCodexHome(), "sessions");
  const files = await findSessionFiles(sessionsRoot);
  return listSessionsFromFiles(files, {
    readFile: readSessionFile,
    readListFile: readFileHead,
    cachePath: getCachePath(),
    writeCache: true,
    lightweight: true
  });
}

export async function listTrashSessions(): Promise<CodexSession[]> {
  const trashSessionsRoot = path.join(getTrashRoot(), "sessions");
  const files = await findSessionFiles(trashSessionsRoot);
  return listSessionsFromFiles(files, {
    readFile: readSessionFile,
    readListFile: readFileHead,
    cachePath: getTrashCachePath(),
    writeCache: true,
    lightweight: true
  });
}

export async function listCachedSessions(cachePath: string): Promise<CodexSession[]> {
  const cache = await readCache(cachePath);
  return sortSessions(Object.values(cache.sessions).map((item) => item.session));
}

export async function listSessionsFromFiles(
  files: CodexSessionFile[],
  options: {
    readFile: (filePath: string) => Promise<string>;
    readListFile?: (filePath: string) => Promise<string>;
    cachePath?: string;
    writeCache?: boolean;
    lightweight?: boolean;
  }
): Promise<CodexSession[]> {
  const cache = options.cachePath ? await readCache(options.cachePath) : emptyCache();
  const nextCache = emptyCache();
  const sessions = await mapLimit(files, LIST_PARSE_CONCURRENCY, async (file) => {
      const cached = cache.sessions[file.filePath];
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        nextCache.sessions[file.filePath] = cached;
        return cached.session;
      }

      const content =
        options.lightweight && options.readListFile
          ? await options.readListFile(file.filePath)
          : await options.readFile(file.filePath);
      const session = options.lightweight
        ? parseSessionListContent(file, content)
        : parseSessionContent(file.filePath, content);
      if (!session) return null;

      nextCache.sessions[file.filePath] = {
        mtimeMs: file.mtimeMs,
        size: file.size,
        session
      };
      return session;
    });

  if (options.cachePath && options.writeCache) {
    await writeCache(options.cachePath, nextCache);
  }

  return sortSessions(sessions.filter((session): session is CodexSession => Boolean(session)));
}

export async function removeSessionFromCache(cachePath: string, filePath: string) {
  await removeSessionsFromCache(cachePath, [filePath]);
}

export async function removeSessionsFromCache(cachePath: string, filePaths: string[]) {
  if (filePaths.length === 0) return;
  if (sessionCacheDatabasePath) {
    await removeSessionCacheEntries(cachePath, filePaths);
    return;
  }
  const cache = await readCache(cachePath);
  for (const filePath of filePaths) delete cache.sessions[filePath];
  await writeCache(cachePath, cache);
}

export async function deleteSession(sessionId: string, filePathHint?: string) {
  const codexHome = getCodexHome();
  const sessionsRoot = path.join(codexHome, "sessions");
  const source = await resolveLocalSource(sessionId, filePathHint, sessionsRoot, findActiveSessionFile);
  assertInsideDir(source, sessionsRoot, "拒绝将 sessions 目录之外的文件移动到回收站");

  const relative = path.relative(codexHome, source);
  const target = path.join(getTrashRoot(), relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  await removeSessionFromCache(getCachePath(), source);

  return { movedTo: target };
}

export async function deleteSessions(sessions: SessionMutationRef[]) {
  const processed: Array<SessionMutationRef & { movedTo: string }> = [];
  try {
    for (const session of sessions) {
      const codexHome = getCodexHome();
      const sessionsRoot = path.join(codexHome, "sessions");
      const source = await resolveLocalSource(session.id, session.filePath, sessionsRoot, findActiveSessionFile);
      assertInsideDir(source, sessionsRoot, "拒绝将 sessions 目录之外的文件移动到回收站");
      const relative = path.relative(codexHome, source);
      const target = path.join(getTrashRoot(), relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      processed.push({ ...session, filePath: source, movedTo: target });
    }
  } finally {
    await removeSessionsFromCache(getCachePath(), processed.map((session) => session.filePath!));
  }

  return processed;
}

export async function restoreSession(sessionId: string) {
  const trashRoot = getTrashRoot();
  const source = await findTrashSessionFile(sessionId);
  const trashSessionsRoot = path.join(trashRoot, "sessions");
  assertInsideDir(source, trashSessionsRoot, "拒绝恢复回收站目录之外的文件");

  const relative = path.relative(trashRoot, source);
  const target = path.join(getCodexHome(), relative);
  await fs.mkdir(path.dirname(target), { recursive: true });

  if (await pathExists(target)) throw new Error("原位置已存在同名会话文件，无法恢复。");
  await fs.rename(source, target);

  await removeSessionFromCache(getCachePath(), target);
  return { restoredTo: target };
}

export async function purgeSession(sessionId: string, filePathHint?: string) {
  const trashRoot = getTrashRoot();
  const trashSessionsRoot = path.join(trashRoot, "sessions");
  const source = await resolveLocalSource(sessionId, filePathHint, trashSessionsRoot, findTrashSessionFile);
  assertInsideDir(source, trashSessionsRoot, "拒绝删除回收站目录之外的文件");

  await fs.unlink(source);
  return { deleted: source };
}

// 渲染层可提供 filePath 快路径以避免全量扫描；用前必须验证它落在期望目录内，
// 且文件确实属于该 sessionId（与 WSL 分支的 verifyWslSessionId 等价的安全校验）。
async function resolveLocalSource(
  sessionId: string,
  filePathHint: string | undefined,
  expectedRoot: string,
  fallback: (sessionId: string) => Promise<string>
) {
  if (!filePathHint) return fallback(sessionId);
  assertInsideDir(filePathHint, expectedRoot, "提供的会话文件路径不在允许目录内");
  await verifyLocalSessionId(filePathHint, sessionId);
  return filePathHint;
}

async function verifyLocalSessionId(filePath: string, sessionId: string) {
  const head = await readFileHead(filePath);
  if (!head.includes(sessionId)) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

async function findActiveSessionFile(sessionId: string) {
  const session = (await listSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到会话：${sessionId}`);
  return session.filePath;
}

async function findTrashSessionFile(sessionId: string) {
  const session = (await listTrashSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未在回收站找到会话：${sessionId}`);
  return session.filePath;
}

function assertInsideDir(filePath: string, dirPath: string, message: string) {
  const relative = path.relative(dirPath, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

async function findSessionFiles(root: string): Promise<CodexSessionFile[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) return findSessionFiles(fullPath);
        if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) {
          const stat = await fs.stat(fullPath);
          return [{ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size }];
        }
        return [];
      })
    );
    return results.flat();
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readFileHead(filePath: string) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(LIST_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LIST_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readSessionFile(filePath: string) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SESSION_READ_BYTES) {
    throw new Error(`会话文件过大，拒绝一次性读取：${path.basename(filePath)}`);
  }
  return fs.readFile(filePath, "utf8");
}

export async function readSessionFileLines(
  filePath: string,
  onLine: (line: string, lineNumber: number) => void | boolean | Promise<void | boolean>,
  startLine = 1
) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if ((await onLine(line, lineNumber)) === false) break;
    }
  } finally {
    input.destroy();
  }
}

async function readCache(cachePath: string): Promise<SessionCache> {
  if (sessionCacheDatabasePath) {
    return {
      version: CACHE_VERSION,
      sessions: await readSessionCache(cachePath)
    };
  }
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, "utf8")) as SessionCache;
    if (cache.version !== CACHE_VERSION || !cache.sessions) return emptyCache();
    return cache;
  } catch {
    return emptyCache();
  }
}

async function writeCache(cachePath: string, cache: SessionCache) {
  if (sessionCacheDatabasePath) {
    const entries: Record<string, SessionCacheEntry> = Object.fromEntries(
      Object.entries(cache.sessions).map(([filePath, entry]) => [filePath, {
        filePath,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        session: entry.session
      }])
    );
    await replaceSessionCache(cachePath, entries);
    return;
  }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const previous = cacheWriteQueues.get(cachePath)?.catch(() => undefined) || Promise.resolve();
  const next = previous.then(() => writeJsonAtomic(cachePath, JSON.stringify(cache)));
  cacheWriteQueues.set(cachePath, next);
  try {
    await next;
  } finally {
    if (cacheWriteQueues.get(cachePath) === next) cacheWriteQueues.delete(cachePath);
  }
}

function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, sessions: {} };
}

function sortSessions(sessions: CodexSession[]) {
  return sessions.sort((a, b) => {
    const left = Date.parse(b.updatedAt || b.createdAt || "");
    const right = Date.parse(a.updatedAt || a.createdAt || "");
    return (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeJsonAtomic(filePath: string, content: string) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
