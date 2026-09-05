import { describe, expect, it, vi } from "vitest";
import type { SessionStorage } from "./session-storage";
import { readSessionWithParser } from "./session-reader";

function createFakeStorage(): SessionStorage {
  return {
    readText: vi.fn(),
    writeText: vi.fn(),
    readLines: vi.fn(async (_filePath, onLine, startLine) => {
      await onLine("first", startLine || 1);
      await onLine("second", (startLine || 1) + 1);
    }),
    exists: vi.fn(),
    move: vi.fn(),
    remove: vi.fn()
  };
}

describe("readSessionWithParser", () => {
  it("按逐行读取后再调用解析器 finish，并透传起始行", async () => {
    const storage = createFakeStorage();
    const lines: string[] = [];
    const parser = {
      push: (line: string) => { lines.push(line); },
      finish: () => ({ lines: [...lines] })
    };

    await expect(readSessionWithParser(storage, "/session.jsonl", parser, 9))
      .resolves.toEqual({ lines: ["first", "second"] });
    expect(storage.readLines).toHaveBeenCalledWith("/session.jsonl", parser.push, 9);
  });

  it("逐行读取失败时向调用方传播错误且不调用 finish", async () => {
    const storage = createFakeStorage();
    const error = new Error("读取失败");
    vi.mocked(storage.readLines).mockRejectedValue(error);
    const finish = vi.fn(() => "unexpected");

    await expect(readSessionWithParser(storage, "/session.jsonl", { push: vi.fn(), finish }))
      .rejects.toBe(error);
    expect(finish).not.toHaveBeenCalled();
  });
});
