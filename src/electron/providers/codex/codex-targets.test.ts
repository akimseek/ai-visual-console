import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexTarget } from "../../types";
import { setSessionCacheRoot } from "./codex-store";

vi.mock("../session-metadata", () => ({
  applySessionMetadata: async (_targetId: string, session: unknown) => session,
  applySessionMetadataList: async (_targetId: string, sessions: unknown) => sessions,
  deleteSessionMetadata: async () => undefined,
  setSessionBranchMetadata: async () => ({})
}));

import { canonicalizeForkedSession, findBranchTurnId, getSession, getSessionMessagesPage } from "./codex-targets";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
let workDir = "";
let codexHome = "";

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-targets-test-"));
  codexHome = path.join(workDir, ".codex");
  process.env.CODEX_HOME = codexHome;
  setSessionCacheRoot(path.join(workDir, "cache"));
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("findBranchTurnId", () => {
  it("按详情原始行号定位外层 task_started 轮次，而不是消息的嵌套事件 ID", async () => {
    const source = path.join(workDir, `rollout-${SESSION_ID}.jsonl`);
    const records = [
      { type: "session_meta", payload: { id: SESSION_ID, session_id: SESSION_ID, cwd: "/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第一轮问题" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第一轮回答" }], internal_chat_message_metadata_passthrough: { turn_id: "nested-event-1" } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第二轮问题" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二轮回答" }], internal_chat_message_metadata_passthrough: { turn_id: "nested-event-2" } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } }
    ];
    await fs.writeFile(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const target = { kind: "local" } as CodexTarget;

    await expect(findBranchTurnId(target, source, 4)).resolves.toBe("turn-1");
    await expect(findBranchTurnId(target, source, 8)).resolves.toBe("turn-2");
  });

  it("拒绝非可见消息及已失效的详情行", async () => {
    const source = path.join(workDir, `rollout-${SESSION_ID}.jsonl`);
    const records = [
      { type: "session_meta", payload: { id: SESSION_ID } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] } }
    ];
    await fs.writeFile(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    const target = { kind: "local" } as CodexTarget;

    await expect(findBranchTurnId(target, source, 2)).rejects.toThrow("分支位置不是可见会话消息");
    await expect(findBranchTurnId(target, source, 99)).rejects.toThrow("分支位置已失效");
  });
});

describe("canonicalizeForkedSession", () => {
  it("以 App Server 返回的新线程 ID 为权威，不因 JSONL 暂时携带父 ID 而拒绝分支", () => {
    const parent = {
      id: SESSION_ID,
      title: "父会话",
      filePath: path.join(codexHome, "sessions", "2026", "06", `rollout-parent-${SESSION_ID}.jsonl`),
      messageCount: 1,
      preview: []
    };
    const branchId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const branchPath = path.join(codexHome, "sessions", "2026", "06", `rollout-branch-${branchId}.jsonl`);
    const parsedBranch = { ...parent, title: "分支", filePath: branchPath };
    const result = canonicalizeForkedSession(
      { kind: "local", codexHome } as CodexTarget,
      parent,
      parsedBranch,
      { threadId: branchId, filePath: branchPath }
    );

    expect(result.id).toBe(branchId);
    expect(result.filePath).toBe(branchPath);
  });

  it("拒绝父子线程 ID 或文件路径相同", () => {
    const parent = {
      id: SESSION_ID,
      title: "父会话",
      filePath: path.join(codexHome, "sessions", "2026", "06", `rollout-parent-${SESSION_ID}.jsonl`),
      messageCount: 1,
      preview: []
    };
    expect(() => canonicalizeForkedSession(
      { kind: "local", codexHome } as CodexTarget,
      parent,
      parent,
      { threadId: SESSION_ID, filePath: path.join(codexHome, "sessions", "2026", "06", "rollout-other.jsonl") }
    )).toThrow("分支会话编号无效");
    expect(() => canonicalizeForkedSession(
      { kind: "local", codexHome } as CodexTarget,
      parent,
      parent,
      { threadId: "66666666-7777-8888-9999-aaaaaaaaaaaa", filePath: parent.filePath }
    )).toThrow("分支文件与原会话相同");
  });
});

describe("getSessionMessagesPage", () => {
  it("首屏返回最新消息，并可按绝对偏移向前读取", async () => {
    const sessionsDir = path.join(codexHome, "sessions", "2026", "06", "16");
    const source = path.join(sessionsDir, `rollout-2026-06-16T10-00-00-${SESSION_ID}.jsonl`);
    const records = [
      { type: "session_meta", payload: { id: SESSION_ID, cwd: "/workspace" } },
      ...Array.from({ length: 150 }, (_, index) => ({
        type: "response_item",
        payload: {
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "input_text", text: `message-${index}` }]
        }
      }))
    ];
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(source, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const latest = await getSessionMessagesPage("local", SESSION_ID, -1, 100);
    expect(latest).toMatchObject({ offset: 50, hasMore: true });
    expect(latest.messages).toHaveLength(100);
    expect(latest.messages.slice(0, 2)).toMatchObject([{ text: "message-50", sourceLine: 52 }, { text: "message-51", sourceLine: 53 }]);

    const earlier = await getSessionMessagesPage("local", SESSION_ID, 0, 50);
    expect(earlier).toMatchObject({ offset: 0, hasMore: true });
    expect(earlier.messages).toHaveLength(50);
    expect(earlier.messages.slice(0, 2)).toMatchObject([{ text: "message-0" }, { text: "message-1" }]);
  });
});

describe("getSession filePath 快路径", () => {
  it("直接读取已知会话文件，并拒绝会话目录之外的路径", async () => {
    const sessionsDir = path.join(codexHome, "sessions", "2026", "06", "15");
    const source = path.join(sessionsDir, `rollout-2026-06-15T14-33-16-${SESSION_ID}.jsonl`);
    const content = `${JSON.stringify({
      timestamp: "2026-06-15T14:33:16.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: "/workspace" }
    })}\n`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(source, content, "utf8");

    const session = await getSession("local", SESSION_ID, { filePath: source });
    expect(session.id).toBe(SESSION_ID);
    await expect(getSession("local", SESSION_ID, { filePath: path.join(workDir, "outside.jsonl") })).rejects.toThrow(
      "拒绝读取 Codex 会话目录之外的文件"
    );
  });
});
