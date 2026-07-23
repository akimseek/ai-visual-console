import type { CodexSession } from "./types";
import {
  hasAppDatabase,
  readSessionCache,
  replaceSessionCache,
  type SessionCacheEntry
} from "./appDatabase";

export type ProviderSessionFile = {
  filePath: string;
  mtimeMs?: number;
  size?: number;
};

export async function listCachedProviderSessions<T extends CodexSession>(cacheKey: string): Promise<T[]> {
  if (!hasAppDatabase()) return [];
  return Object.values(await readSessionCache(cacheKey)).map((entry) => entry.session as T);
}

export async function findCachedProviderSession<T extends CodexSession>(
  cacheKeys: string[],
  sessionId: string
): Promise<T | null> {
  if (!hasAppDatabase()) return null;
  for (const cacheKey of cacheKeys) {
    const entry = Object.values(await readSessionCache(cacheKey)).find((item) => item.session.id === sessionId);
    if (entry) return entry.session as T;
  }
  return null;
}

export async function loadProviderSessionCache<T extends CodexSession, TFile extends ProviderSessionFile>(
  cacheKey: string,
  files: TFile[],
  loadSession: (file: TFile) => Promise<T | null>,
  concurrency = 8
): Promise<T[]> {
  const cache = hasAppDatabase() ? await readSessionCache(cacheKey) : {};
  const nextCache: Record<string, SessionCacheEntry> = {};
  const sessions = await mapLimit(files, concurrency, async (file) => {
    const cached = cache[file.filePath];
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
      nextCache[file.filePath] = cached;
      return cached.session as T;
    }

    try {
      const session = await loadSession(file);
      if (!session) return null;
      nextCache[file.filePath] = {
        filePath: file.filePath,
        mtimeMs: file.mtimeMs || 0,
        size: file.size || 0,
        session
      };
      return session;
    } catch {
      // 单个临时被删除或不可读的 JSONL 不应阻断整个历史列表。
      return null;
    }
  });
  if (hasAppDatabase()) await replaceSessionCache(cacheKey, nextCache);
  return sessions.filter((session): session is T => Boolean(session));
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
