import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./sessionMetadata", () => ({
  applySessionMetadataList: async (_targetId: string, sessions: unknown[]) => sessions,
  findSessionIdsByParent: async () => null,
  setSessionBranchMetadata: async (_targetId: string, _sessionId: string, branch: unknown) => ({ branch })
}));

import {
  deleteSession,
  branchSession,
  getSession,
  getSessionMessagesPage,
  listSessions,
  purgeSession,
  restoreSession,
  searchSessions
} from "./geminiProvider";

// geminiProvider 无 electron 依赖。按真实布局（~/.gemini/tmp/<项目>/chats/session-*.jsonl
// + projects.json 提供 cwd 映射）铺设 fixture，端到端覆盖其特有的 jsonl 形态解析
// （元数据行 + $set/type 消息行 + tokens 用量）、排序、搜索，以及删除/恢复/彻底删除的路径围栏。

let homeDir = "";
let configDir = "";
let tmpRoot = "";
let trashTmpRoot = "";

const SESSION_A = "gem-aaaa";
const SESSION_B = "gem-bbbb";
const FILE_A = "session-2024-01-01T10-00-aaaaaaaa.jsonl";
const FILE_B = "session-2024-01-01T09-00-bbbbbbbb.jsonl";

async function writeGeminiSession(projectKey: string, fileName: string, lines: object[]) {
  const chatsDir = path.join(tmpRoot, projectKey, "chats");
  await fs.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, fileName);
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return filePath;
}

async function exists(filePath: string) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
  configDir = path.join(homeDir, ".gemini");
  tmpRoot = path.join(configDir, "tmp");
  trashTmpRoot = path.join(configDir, ".visual-console-trash", "tmp");
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "projects.json"),
    JSON.stringify({ projects: { "/home/u/projA": "projA", "/home/u/projB": "projB" } }),
    "utf8"
  );

  await writeGeminiSession("projA", FILE_A, [
    { sessionId: SESSION_A, projectHash: "projA", startTime: "2024-01-01T10:00:00Z", lastUpdated: "2024-01-01T10:05:00Z", summary: "Gemini summary A", kind: "main" },
    { type: "user", timestamp: "2024-01-01T10:01:00Z", content: "Hello gemini about dogs" },
    { type: "gemini", timestamp: "2024-01-01T10:02:00Z", model: "gemini-2.5-pro", content: "Woof reply", tokens: { input: 1000, cached: 200, output: 300, total: 1500 } }
  ]);
  await writeGeminiSession("projB", FILE_B, [
    { sessionId: SESSION_B, projectHash: "projB", startTime: "2024-01-01T09:00:00Z", lastUpdated: "2024-01-01T09:05:00Z", summary: "", kind: "main" },
    { type: "user", timestamp: "2024-01-01T09:01:00Z", content: "Older cats question" },
    { type: "gemini", timestamp: "2024-01-01T09:02:00Z", model: "gemini-2.5-flash", content: "meow", tokens: { input: 10, output: 5, total: 15 } }
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("listSessions（解析 + 排序）", () => {
  it("解析元数据/消息/tokens，按 updatedAt 倒序，标题取 summary 或首条用户消息", async () => {
    const sessions = await listSessions("gemini:local");
    expect(sessions.map((session) => session.id)).toEqual([SESSION_A, SESSION_B]);

    const [first, second] = sessions;
    expect(first.title).toBe("Gemini summary A");
    expect(first.cwd).toBe("/home/u/projA"); // 来自 projects.json 的 projectKey→cwd 映射
    expect(first.model).toBe("gemini-2.5-pro");
    expect(first.preview).toHaveLength(2);
    expect(first.usage?.total?.totalTokens).toBe(1500);
    expect(first.usage?.contextWindow).toBe(1_048_576);

    // summary 为空时回退到首条用户消息
    expect(second.title).toBe("Older cats question");
  });

  it("kind=subagent 的会话被忽略", async () => {
    await writeGeminiSession("projC", "session-2024-01-01T11-00-cccccccc.jsonl", [
      { sessionId: "gem-cccc", projectHash: "projC", startTime: "2024-01-01T11:00:00Z", lastUpdated: "2024-01-01T11:05:00Z", kind: "subagent" },
      { type: "user", timestamp: "2024-01-01T11:01:00Z", content: "subagent noise" }
    ]);
    const ids = (await listSessions("gemini:local")).map((session) => session.id);
    expect(ids).not.toContain("gem-cccc");
  });
});

describe("searchSessions", () => {
  it("按正文大小写无关匹配", async () => {
    const hits = await searchSessions("gemini:local", "active", "DOGS");
    expect(hits.map((session) => session.id)).toEqual([SESSION_A]);
  });

  it("列表仅缓存有限预览，但全文搜索仍可命中后续消息", async () => {
    await writeGeminiSession("projA", "session-2024-01-01T12-00-eeeeeeee.jsonl", [
      { sessionId: "gem-preview", projectHash: "projA", startTime: "2024-01-01T12:00:00Z", lastUpdated: "2024-01-01T12:10:00Z", kind: "main" },
      { type: "user", timestamp: "2024-01-01T12:00:00Z", content: "Preview question" },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: "gemini",
        timestamp: `2024-01-01T12:${String(index + 1).padStart(2, "0")}:00Z`,
        content: `Later answer ${index + 1}`
      }))
    ]);

    const preview = (await listSessions("gemini:local")).find((session) => session.id === "gem-preview");
    expect(preview?.preview).toHaveLength(8);
    expect(preview?.messageCount).toBe(11);
    expect((await searchSessions("gemini:local", "active", "Later answer 10")).map((session) => session.id)).toContain("gem-preview");
    await expect(getSessionMessagesPage("gemini:local", "gem-preview", 8, 2)).resolves.toMatchObject({
      offset: 8,
      messages: [{ text: "Later answer 8" }, { text: "Later answer 9" }],
      hasMore: true
    });
    await expect(getSessionMessagesPage("gemini:local", "gem-preview", -1, 2)).resolves.toMatchObject({
      offset: 9,
      messages: [{ text: "Later answer 9" }, { text: "Later answer 10" }],
      hasMore: true
    });
  });
});

describe("getSession", () => {
  it("找不到会话时抛错", async () => {
    await expect(getSession("gemini:local", "missing")).rejects.toThrow("未找到 Gemini");
  });

  it("携带 filePath 时直接读取指定会话", async () => {
    const filePath = path.join(tmpRoot, "projA", "chats", FILE_A);
    await expect(getSession("gemini:local", SESSION_A, { filePath })).resolves.toMatchObject({ id: SESSION_A });
  });
});

describe("branchSession", () => {
  it("可从列表预览之外的绝对消息位置创建分支", async () => {
    await writeGeminiSession("projA", "session-2024-01-01T12-00-cccccccc.jsonl", [
      { sessionId: "gem-long", projectHash: "projA", startTime: "2024-01-01T12:00:00Z", lastUpdated: "2024-01-01T12:12:00Z", kind: "main" },
      { type: "user", timestamp: "2024-01-01T12:00:00Z", content: "Start" },
      ...Array.from({ length: 12 }, (_, index) => ({ type: "gemini", timestamp: `2024-01-01T12:${String(index + 1).padStart(2, "0")}:00Z`, content: `Answer ${index + 1}` }))
    ]);

    await expect(branchSession("gemini:local", "gem-long", 10)).resolves.toMatchObject({ messageCount: 10 });
  });
});

describe("deleteSession / restoreSession / purgeSession", () => {
  it("删除把文件移入回收站对应子路径", async () => {
    const result = await deleteSession("gemini:local", SESSION_A);
    const movedTo = path.join(trashTmpRoot, "projA", "chats", FILE_A);
    expect(await exists(path.join(tmpRoot, "projA", "chats", FILE_A))).toBe(false);
    expect(await exists(movedTo)).toBe(true);
    expect(result.movedTo).toBe(movedTo);
  });

  it("拒绝操作 tmp 目录之外的文件（伪造 ref.filePath）", async () => {
    const outside = path.join(configDir, "evil.jsonl");
    await fs.writeFile(outside, JSON.stringify({ sessionId: SESSION_A }), "utf8");
    await expect(deleteSession("gemini:local", SESSION_A, { filePath: outside })).rejects.toThrow("拒绝操作");
  });

  it("恢复把文件从回收站移回 tmp", async () => {
    await deleteSession("gemini:local", SESSION_A);
    const result = await restoreSession("gemini:local", SESSION_A);
    const restoredTo = path.join(tmpRoot, "projA", "chats", FILE_A);
    expect(result.restoredTo).toBe(restoredTo);
    expect(await exists(restoredTo)).toBe(true);
  });

  it("彻底删除从回收站抹除文件", async () => {
    await deleteSession("gemini:local", SESSION_A);
    const result = await purgeSession("gemini:local", SESSION_A);
    expect(result.deleted).toBe(path.join(trashTmpRoot, "projA", "chats", FILE_A));
    expect(await exists(path.join(trashTmpRoot, "projA", "chats", FILE_A))).toBe(false);
  });
});
