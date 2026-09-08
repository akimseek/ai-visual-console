import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionContent } from "../../../shared/session-parser";
import { setSessionCacheRoot } from "./codex-store";

vi.mock("../session-metadata", () => ({
  applySessionMetadata: async (_targetId: string, session: unknown) => session,
  applySessionMetadataList: async (_targetId: string, sessions: unknown) => sessions,
  setSessionBranchMetadata: async () => ({})
}));

import { branchSession, getSession, getSessionMessagesPage } from "./codex-targets";

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

describe("branchSession", () => {
  it("可从超过整文件读取限制的本地 JSONL 创建截断分支", async () => {
    const sessionsDir = path.join(codexHome, "sessions", "2026", "06", "15");
    const source = path.join(sessionsDir, `rollout-2026-06-15T14-33-16-${SESSION_ID}.jsonl`);
    const meta = JSON.stringify({
      timestamp: "2026-06-15T14:33:16.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, session_id: SESSION_ID, timestamp: "2026-06-15T14:33:16.000Z", cwd: "/workspace", model: "gpt-5", history_mode: "paginated" }
    });
    const user = JSON.stringify({
      timestamp: "2026-06-15T14:33:17.000Z",
      type: "response_item",
      payload: { thread_id: SESSION_ID, type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] }
    });
    const assistant = JSON.stringify({
      timestamp: "2026-06-15T14:33:18.000Z",
      type: "response_item",
      payload: { thread_id: SESSION_ID, type: "message", role: "assistant", content: [{ type: "output_text", text: "回答" }] }
    });
    const turnContext = JSON.stringify({
      timestamp: "2026-06-15T14:33:18.100Z",
      type: "turn_context",
      payload: { thread_id: SESSION_ID, model: "gpt-5", model_provider: "openai", effort: "high" }
    });
    const sessionControl = JSON.stringify({
      timestamp: "2026-06-15T14:33:18.200Z",
      type: "event_msg",
      payload: { session_id: SESSION_ID, type: "turn_completed" }
    });
    const followUp = JSON.stringify({
      timestamp: "2026-06-15T14:33:19.000Z",
      type: "response_item",
      payload: { thread_id: SESSION_ID, type: "message", role: "user", content: [{ type: "input_text", text: "追问" }] }
    });
    const trailing = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {}, pad: "x".repeat(700 * 1024) } })}\n`;
    const padding = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {}, pad: "x".repeat(700 * 1024) } })}\n`;

    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(source, `${meta}\n${user}\n${assistant}\n${turnContext}\n${sessionControl}\n`, "utf8");
    await fs.appendFile(source, padding);
    await fs.appendFile(source, `${followUp}\n`, "utf8");
    for (let index = 0; index < 48; index += 1) await fs.appendFile(source, trailing, "utf8");
    expect((await fs.stat(source)).size).toBeGreaterThan(32 * 1024 * 1024);

    // 列表摘要只读取文件首段，故其 messageCount 可能小于此处的绝对偏移。
    const branch = await branchSession("local", SESSION_ID, 7);
    const branchText = await fs.readFile(branch.filePath, "utf8");
    const parsed = parseSessionContent(branch.filePath, branchText);

    expect(branch.id).not.toBe(SESSION_ID);
    expect(parsed?.id).toBe(branch.id);
    expect(parsed?.preview.map((message) => message.text)).toEqual(["问题", "回答", "追问"]);
    expect(branchText).toContain('"type":"turn_context"');
    expect(branchText).toContain(`"session_id":"${branch.id}"`);
    // 分支 JSONL 的全部控制记录必须归属新线程，Codex resume 才会加载历史消息。
    const branchThreadIds = branchText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { payload?: { thread_id?: string } })
      .map((item) => item.payload?.thread_id)
      .filter((threadId): threadId is string => Boolean(threadId));
    expect(branchThreadIds).toEqual([branch.id, branch.id, branch.id, branch.id]);
    expect(branchText).not.toContain(`"session_id":"${SESSION_ID}"`);
    expect(branchText).not.toContain('"history_mode":"paginated"');
    expect((await fs.stat(branch.filePath)).size).toBeLessThan(32 * 1024 * 1024);
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
