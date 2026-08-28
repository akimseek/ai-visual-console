import { describe, expect, it } from "vitest";
import { normalizeChosenDirectory, windowsPathToWslPath } from "./new-session-paths";

describe("new session paths", () => {
  it("将 Windows 目录转换为 WSL 挂载路径", () => {
    expect(windowsPathToWslPath("D:\\code\\ai")).toBe("/mnt/d/code/ai");
    expect(windowsPathToWslPath("c:/work/demo")).toBe("/mnt/c/work/demo");
  });

  it("仅为 WSL 目标转换目录分隔符", () => {
    expect(
      normalizeChosenDirectory("D:\\code\\ai", {
        id: "wsl:ubuntu",
        kind: "wsl",
        label: "Ubuntu",
        provider: "codex",
        available: true
      })
    ).toBe("/mnt/d/code/ai");
    expect(
      normalizeChosenDirectory("D:\\code\\ai", {
        id: "local",
        kind: "local",
        label: "本机",
        provider: "codex",
        available: true
      })
    ).toBe("D:\\code\\ai");
  });
});
