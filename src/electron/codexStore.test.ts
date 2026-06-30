import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSession, purgeSession, setSessionCacheRoot } from "./codexStore";

// D1 回归：本地删除/彻底删除接受渲染层提供的 filePath 快路径，
// 但必须验证它落在 sessions / 回收站目录内，且文件确实属于该 sessionId。

let workDir = "";
let codexHome = "";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

async function writeRollout(dir: string, name: string, sessionId: string) {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId } });
  await fs.writeFile(filePath, `${meta}\n`, "utf8");
  return filePath;
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-store-test-"));
  codexHome = path.join(workDir, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  setSessionCacheRoot(path.join(workDir, "cache"));
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("deleteSession 快路径", () => {
  it("有效 filePath 直接移动到回收站，无需全量扫描", async () => {
    const source = await writeRollout(path.join(codexHome, "sessions", "2026"), "rollout-a.jsonl", SESSION_ID);
    const result = await deleteSession(SESSION_ID, source);
    expect(result.movedTo).toContain(".visual-console-trash");
    expect(await exists(source)).toBe(false);
    expect(await exists(result.movedTo)).toBe(true);
  });

  it("拒绝 sessions 目录之外的 filePath（穿越防护）", async () => {
    const outside = path.join(codexHome, "secret.txt");
    await fs.writeFile(outside, "secret", "utf8");
    await expect(deleteSession(SESSION_ID, outside)).rejects.toThrow();
    expect(await exists(outside)).toBe(true);
  });

  it("拒绝与 sessionId 不匹配的 filePath", async () => {
    const source = await writeRollout(path.join(codexHome, "sessions"), "rollout-b.jsonl", "other-id");
    await expect(deleteSession(SESSION_ID, source)).rejects.toThrow();
    expect(await exists(source)).toBe(true);
  });
});

describe("purgeSession 快路径", () => {
  it("有效回收站 filePath 被物理删除", async () => {
    const trashSessions = path.join(codexHome, ".visual-console-trash", "sessions");
    const source = await writeRollout(trashSessions, "rollout-c.jsonl", SESSION_ID);
    const result = await purgeSession(SESSION_ID, source);
    expect(result.deleted).toBe(source);
    expect(await exists(source)).toBe(false);
  });

  it("拒绝回收站目录之外的 filePath", async () => {
    const source = await writeRollout(path.join(codexHome, "sessions"), "rollout-d.jsonl", SESSION_ID);
    await expect(purgeSession(SESSION_ID, source)).rejects.toThrow();
    expect(await exists(source)).toBe(true);
  });
});
