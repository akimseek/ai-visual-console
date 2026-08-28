import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../session-metadata", () => ({
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
} from "./claude-provider";

// Claude Provider 无 electron 依赖，可直接 import。把 os.homedir 指向临时目录，按真实布局
// （~/.claude/projects/<项目>/<会话>.jsonl）铺设 fixture，端到端覆盖 jsonl 解析、排序、搜索，
// 以及删除/恢复/彻底删除的路径围栏（拒绝 projects/回收站目录之外的文件）。

let homeDir = "";
let projectsRoot = "";
let trashProjectsRoot = "";

const SESSION_A = "sess-aaaaaaaa";
const SESSION_B = "sess-bbbbbbbb";

async function writeClaudeSession(project: string, fileName: string, lines: object[], mtime: string) {
  const dir = path.join(projectsRoot, project);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  // 解析器取「记录内时间戳」与「文件 mtime」中较晚者作为 updatedAt；显式对齐 mtime 以使排序确定。
  const stamp = new Date(mtime);
  await fs.utimes(filePath, stamp, stamp);
  return filePath;
}

async function exists(filePath: string) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-test-"));
  projectsRoot = path.join(homeDir, ".claude", "projects");
  trashProjectsRoot = path.join(homeDir, ".claude", ".visual-console-trash", "projects");
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);

  await writeClaudeSession("proj1", "a.jsonl", [
    { sessionId: SESSION_A, type: "user", timestamp: "2024-01-01T10:00:00Z", cwd: "/home/u/proj1", message: { role: "user", content: "First question" } },
    { type: "assistant", timestamp: "2024-01-01T10:01:00Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "Answer one" }], usage: { input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 200 } } }
  ], "2024-01-01T10:01:00Z");
  await writeClaudeSession("proj1", "b.jsonl", [
    { sessionId: SESSION_B, type: "user", timestamp: "2024-01-01T09:00:00Z", message: { role: "user", content: "Older question about cats" } },
    { type: "assistant", timestamp: "2024-01-01T09:01:00Z", message: { role: "assistant", model: "claude-3-5-sonnet-20241022", content: "Short answer", usage: { input_tokens: 10, output_tokens: 5 } } }
  ], "2024-01-01T09:01:00Z");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("listSessions（解析 + 排序）", () => {
  it("解析 jsonl，按 updatedAt 倒序，并提取标题/模型/上下文窗口", async () => {
    const sessions = await listSessions("claude:local");
    expect(sessions.map((session) => session.id)).toEqual([SESSION_A, SESSION_B]);

    const [first, second] = sessions;
    expect(first.title).toBe("First question");
    expect(first.cwd).toBe("/home/u/proj1");
    expect(first.model).toBe("claude-opus-4-8");
    expect(first.preview).toHaveLength(2);
    // opus-4-8 / [1m] → 100 万上下文窗口；token 累计应非零
    expect(first.usage?.contextWindow).toBe(1_000_000);
    expect(first.usage?.total?.totalTokens).toBe(1700);

    // 普通 claude-3-5 → 20 万窗口
    expect(second.usage?.contextWindow).toBe(200_000);
  });
});

describe("searchSessions", () => {
  it("按标题/正文大小写无关匹配", async () => {
    const hits = await searchSessions("claude:local", "active", "CATS");
    expect(hits.map((session) => session.id)).toEqual([SESSION_B]);
  });

  it("空查询返回全部", async () => {
    expect(await searchSessions("claude:local", "active", "  ")).toHaveLength(2);
  });

  it("列表仅缓存有限预览，但全文搜索仍可命中后续消息", async () => {
    const lines = [
      { sessionId: "sess-preview", type: "user", timestamp: "2024-01-01T11:00:00Z", message: { role: "user", content: "Preview question" } },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: "assistant",
        timestamp: `2024-01-01T11:${String(index + 1).padStart(2, "0")}:00Z`,
        message: { role: "assistant", content: `Later answer ${index + 1}` }
      }))
    ];
    await writeClaudeSession("proj1", "preview.jsonl", lines, "2024-01-01T11:10:00Z");

    const preview = (await listSessions("claude:local")).find((session) => session.id === "sess-preview");
    expect(preview?.preview).toHaveLength(8);
    expect(preview?.messageCount).toBe(11);
    expect((await searchSessions("claude:local", "active", "Later answer 10")).map((session) => session.id)).toContain("sess-preview");
    await expect(getSessionMessagesPage("claude:local", "sess-preview", 8, 2)).resolves.toMatchObject({
      offset: 8,
      messages: [{ text: "Later answer 8" }, { text: "Later answer 9" }],
      hasMore: true
    });
    await expect(getSessionMessagesPage("claude:local", "sess-preview", -1, 2)).resolves.toMatchObject({
      offset: 9,
      messages: [{ text: "Later answer 9" }, { text: "Later answer 10" }],
      hasMore: true
    });
  });
});

describe("getSession", () => {
  it("找不到会话时抛错", async () => {
    await expect(getSession("claude:local", "missing")).rejects.toThrow("未找到 Claude");
  });

  it("携带 filePath 时直接读取指定会话", async () => {
    const filePath = path.join(projectsRoot, "proj1", "a.jsonl");
    await expect(getSession("claude:local", SESSION_A, { filePath })).resolves.toMatchObject({ id: SESSION_A });
  });
});

describe("branchSession", () => {
  it("可从列表预览之外的绝对消息位置创建分支", async () => {
    await writeClaudeSession("proj1", "long.jsonl", [
      { sessionId: "sess-long", type: "user", timestamp: "2024-01-01T11:00:00Z", message: { role: "user", content: "Start" } },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "assistant",
        timestamp: `2024-01-01T11:${String(index + 1).padStart(2, "0")}:00Z`,
        message: { role: "assistant", content: `Answer ${index + 1}` }
      }))
    ], "2024-01-01T11:12:00Z");

    await expect(branchSession("claude:local", "sess-long", 10)).resolves.toMatchObject({ messageCount: 10 });
  });
});

describe("deleteSession / restoreSession / purgeSession", () => {
  it("删除把文件移入回收站对应子路径", async () => {
    const result = await deleteSession("claude:local", SESSION_A);
    expect(await exists(path.join(projectsRoot, "proj1", "a.jsonl"))).toBe(false);
    expect(await exists(path.join(trashProjectsRoot, "proj1", "a.jsonl"))).toBe(true);
    expect(result.movedTo).toBe(path.join(trashProjectsRoot, "proj1", "a.jsonl"));
  });

  it("拒绝操作 projects 目录之外的文件（伪造 ref.filePath）", async () => {
    const outside = path.join(homeDir, ".claude", "evil.jsonl");
    await fs.writeFile(outside, JSON.stringify({ sessionId: SESSION_A }), "utf8");
    await expect(deleteSession("claude:local", SESSION_A, { filePath: outside })).rejects.toThrow("拒绝操作");
  });

  it("恢复把文件从回收站移回 projects", async () => {
    await deleteSession("claude:local", SESSION_A);
    const result = await restoreSession("claude:local", SESSION_A);
    expect(result.restoredTo).toBe(path.join(projectsRoot, "proj1", "a.jsonl"));
    expect(await exists(path.join(projectsRoot, "proj1", "a.jsonl"))).toBe(true);
  });

  it("彻底删除从回收站抹除文件", async () => {
    await deleteSession("claude:local", SESSION_A);
    const result = await purgeSession("claude:local", SESSION_A);
    expect(result.deleted).toBe(path.join(trashProjectsRoot, "proj1", "a.jsonl"));
    expect(await exists(path.join(trashProjectsRoot, "proj1", "a.jsonl"))).toBe(false);
  });
});
