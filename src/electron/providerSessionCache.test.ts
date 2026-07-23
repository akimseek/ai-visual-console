import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSession } from "./types";

const cacheStore = vi.hoisted(() => new Map<string, Record<string, any>>());

vi.mock("./appDatabase", () => ({
  hasAppDatabase: () => true,
  readSessionCache: async (key: string) => cacheStore.get(key) || {},
  replaceSessionCache: async (key: string, entries: Record<string, any>) => {
    cacheStore.set(key, entries);
  }
}));

import {
  findCachedProviderSession,
  listCachedProviderSessions,
  loadProviderSessionCache
} from "./providerSessionCache";

type FixtureFile = {
  filePath: string;
  mtimeMs: number;
  size: number;
  title: string;
};

function session(id: string, title = id): CodexSession {
  return {
    id,
    title,
    filePath: `/sessions/${id}.jsonl`,
    messageCount: 1,
    preview: []
  };
}

function entry(filePath: string, mtimeMs: number, size: number, value: CodexSession) {
  return { filePath, mtimeMs, size, session: value };
}

beforeEach(() => {
  cacheStore.clear();
});

describe("loadProviderSessionCache", () => {
  it("复用未变更文件，仅解析新增或变更文件", async () => {
    const key = "sessions:gemini:local:active";
    const first = { filePath: "/sessions/a.jsonl", mtimeMs: 10, size: 100, title: "A" };
    const second = { filePath: "/sessions/b.jsonl", mtimeMs: 20, size: 120, title: "B" };
    cacheStore.set(key, {
      [first.filePath]: entry(first.filePath, first.mtimeMs, first.size, session("a", "cached A"))
    });
    const loader = vi.fn(async (file: FixtureFile) => session(file.title.toLowerCase(), file.title));

    const result = await loadProviderSessionCache(key, [first, second], loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(second);
    expect(result.map((item) => item.title)).toEqual(["cached A", "B"]);
    expect(Object.keys(cacheStore.get(key) || {})).toEqual([first.filePath, second.filePath]);
  });

  it("文件读取失败时忽略该条，并淘汰不再存在的旧缓存", async () => {
    const key = "sessions:claude:local:active";
    const stalePath = "/sessions/stale.jsonl";
    const failing = { filePath: "/sessions/failing.jsonl", mtimeMs: 11, size: 80, title: "failing" };
    cacheStore.set(key, {
      [stalePath]: entry(stalePath, 1, 1, session("stale"))
    });

    const result = await loadProviderSessionCache(key, [failing], async () => {
      throw new Error("file disappeared");
    });

    expect(result).toEqual([]);
    expect(cacheStore.get(key)).toEqual({});
  });
});

describe("provider cache reads", () => {
  it("按 cache key 返回缓存，并能跨 active/trash 定位会话", async () => {
    const active = "sessions:gemini:local:active";
    const trash = "sessions:gemini:local:trash";
    cacheStore.set(active, {
      "/sessions/a.jsonl": entry("/sessions/a.jsonl", 1, 1, session("a"))
    });
    cacheStore.set(trash, {
      "/sessions/b.jsonl": entry("/sessions/b.jsonl", 1, 1, session("b"))
    });

    expect((await listCachedProviderSessions<CodexSession>(active)).map((item) => item.id)).toEqual(["a"]);
    await expect(findCachedProviderSession<CodexSession>([active, trash], "b")).resolves.toMatchObject({ id: "b" });
    await expect(findCachedProviderSession<CodexSession>([active, trash], "missing")).resolves.toBeNull();
  });
});
