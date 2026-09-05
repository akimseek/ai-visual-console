import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionStorage } from "./session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("session-storage", () => {
  it("统一本机会话文件的读写、逐行读取和存在性判断", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-storage-"));
    temporaryDirectories.push(directory);
    const storage = createSessionStorage({ kind: "local" });
    const filePath = path.join(directory, "nested", "session.jsonl");

    await storage.writeText(filePath, "one\ntwo\nthree\n");
    const lines: string[] = [];
    await storage.readLines(filePath, (line) => { lines.push(line); });

    expect(await storage.readText(filePath)).toBe("one\ntwo\nthree\n");
    expect(lines).toEqual(["one", "two", "three"]);
    expect(await storage.exists(filePath)).toBe(true);
  });

  it("移动文件时可按调用方要求拒绝覆盖目标", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-storage-"));
    temporaryDirectories.push(directory);
    const storage = createSessionStorage({ kind: "local" });
    const source = path.join(directory, "source.jsonl");
    const destination = path.join(directory, "trash", "session.jsonl");
    await storage.writeText(source, "source");
    await storage.writeText(destination, "existing");

    await expect(storage.move(source, destination, "目标已存在。"))
      .rejects.toThrow("目标已存在。");
    expect(await storage.readText(source)).toBe("source");
    expect(await storage.readText(destination)).toBe("existing");
  });

  it("移动后可以删除文件", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-storage-"));
    temporaryDirectories.push(directory);
    const storage = createSessionStorage({ kind: "local" });
    const source = path.join(directory, "source.jsonl");
    const destination = path.join(directory, "trash", "session.jsonl");
    await storage.writeText(source, "source");

    await storage.move(source, destination);
    await storage.remove(destination);

    expect(await storage.exists(source)).toBe(false);
    expect(await storage.exists(destination)).toBe(false);
  });
});
