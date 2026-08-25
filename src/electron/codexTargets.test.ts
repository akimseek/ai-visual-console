import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionContent } from "../shared/sessionParser";
import { setSessionCacheRoot } from "./codexStore";

vi.mock("./sessionMetadata", () => ({
  applySessionMetadata: async (_targetId: string, session: unknown) => session,
  applySessionMetadataList: async (_targetId: string, sessions: unknown) => sessions,
  setSessionBranchMetadata: async () => ({})
}));

import { branchSession, getSession } from "./codexTargets";

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
      payload: { id: SESSION_ID, timestamp: "2026-06-15T14:33:16.000Z", cwd: "/workspace", model: "gpt-5" }
    });
    const user = JSON.stringify({
      timestamp: "2026-06-15T14:33:17.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] }
    });
    const assistant = JSON.stringify({
      timestamp: "2026-06-15T14:33:18.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "回答" }] }
    });
    const followUp = JSON.stringify({
      timestamp: "2026-06-15T14:33:19.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "追问" }] }
    });
    const trailing = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {}, pad: "x".repeat(700 * 1024) } })}\n`;
    const padding = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {}, pad: "x".repeat(700 * 1024) } })}\n`;

    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(source, `${meta}\n${user}\n${assistant}\n`, "utf8");
    await fs.appendFile(source, padding);
    await fs.appendFile(source, `${followUp}\n`, "utf8");
    for (let index = 0; index < 48; index += 1) await fs.appendFile(source, trailing, "utf8");
    expect((await fs.stat(source)).size).toBeGreaterThan(32 * 1024 * 1024);

    // 列表摘要只读取文件首段，故其 messageCount 可能小于此处的绝对偏移。
    const branch = await branchSession("local", SESSION_ID, 3);
    const branchText = await fs.readFile(branch.filePath, "utf8");
    const parsed = parseSessionContent(branch.filePath, branchText);

    expect(branch.id).not.toBe(SESSION_ID);
    expect(parsed?.id).toBe(branch.id);
    expect(parsed?.preview.map((message) => message.text)).toEqual(["问题", "回答", "追问"]);
    expect((await fs.stat(branch.filePath)).size).toBeLessThan(32 * 1024 * 1024);
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
