import { beforeEach, describe, expect, it, vi } from "vitest";

const wslMocks = vi.hoisted(() => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  readLines: vi.fn(),
  pathExists: vi.fn(),
  runShell: vi.fn(),
  run: vi.fn()
}));

vi.mock("../core/wsl", () => ({
  runWslShell: wslMocks.runShell,
  wslPathExists: wslMocks.pathExists,
  wslReadFile: wslMocks.readText,
  wslRun: wslMocks.run,
  wslWriteFile: wslMocks.writeText
}));

vi.mock("../core/line-reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/line-reader")>();
  return {
    ...actual,
    readWslLines: wslMocks.readLines
  };
});

import { createSessionStorage } from "./session-storage";

describe("session-storage WSL 实现", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wslMocks.readText.mockResolvedValue("session");
    wslMocks.writeText.mockResolvedValue(undefined);
    // 模拟逐行读取器回调，验证公共层不会丢失调用方的处理函数。
    wslMocks.readLines.mockImplementation(async (_distro, _filePath, onLine) => {
      await onLine("first", 1);
    });
    wslMocks.pathExists.mockResolvedValue(true);
    wslMocks.runShell.mockResolvedValue("");
    wslMocks.run.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("缺少 WSL 发行版时立即拒绝创建存储实例", () => {
    expect(() => createSessionStorage({ kind: "wsl" })).toThrow("缺少 WSL 发行版");
  });

  it("将 WSL 会话文件操作委托给统一 WSL 工具", async () => {
    const storage = createSessionStorage({ kind: "wsl", distro: "Ubuntu" });
    const lines: string[] = [];

    expect(await storage.readText("/home/user/session.jsonl")).toBe("session");
    await storage.writeText("/home/user/new.jsonl", "content");
    await storage.readLines("/home/user/session.jsonl", (line) => { lines.push(line); }, 7);
    expect(await storage.exists("/home/user/session.jsonl")).toBe(true);
    await storage.move("/home/user/session.jsonl", "/home/user/trash/session.jsonl", "目标已存在。");
    await storage.remove("/home/user/trash/session.jsonl");

    expect(wslMocks.readText).toHaveBeenCalledWith("Ubuntu", "/home/user/session.jsonl");
    expect(wslMocks.writeText).toHaveBeenCalledWith("Ubuntu", "/home/user/new.jsonl", "content");
    expect(wslMocks.readLines).toHaveBeenCalledWith(
      "Ubuntu",
      "/home/user/session.jsonl",
      expect.any(Function),
      7
    );
    expect(wslMocks.pathExists).toHaveBeenCalledWith("Ubuntu", "/home/user/session.jsonl");
    expect(wslMocks.runShell).toHaveBeenCalledWith(
      "Ubuntu",
      expect.stringContaining("目标已存在")
    );
    expect(wslMocks.run).toHaveBeenCalledWith(
      "Ubuntu",
      "rm",
      ["-f", "/home/user/trash/session.jsonl"]
    );
    expect(lines).toEqual(["first"]);
  });
});
