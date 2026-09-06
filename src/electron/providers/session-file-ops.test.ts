import { describe, expect, it } from "vitest";
import { assertSessionFileInside, isInsideSessionRoot, relocateSessionPath } from "./session-file-ops";

describe("session-file-ops", () => {
  it("按本机路径边界映射回收站目标", () => {
    expect(relocateSessionPath(
      "C:\\work\\projects\\a\\session.jsonl",
      "C:\\work\\projects",
      "C:\\work\\trash\\projects",
      "local",
      "越界"
    )).toBe("C:\\work\\trash\\projects\\a\\session.jsonl");
  });

  it("按 WSL 路径边界映射回收站目标", () => {
    expect(relocateSessionPath(
      "/home/me/.claude/projects/a/session.jsonl",
      "/home/me/.claude/projects",
      "/home/me/.claude/.visual-console-trash/projects",
      "wsl",
      "越界"
    )).toBe("/home/me/.claude/.visual-console-trash/projects/a/session.jsonl");
  });

  it("拒绝根目录本身和目录外文件", () => {
    expect(isInsideSessionRoot("/tmp/projects-evil/a.jsonl", "/tmp/projects", "wsl")).toBe(false);
    expect(() => assertSessionFileInside("/tmp/projects", "/tmp/projects", "wsl", "越界")).toThrow("越界");
  });

  it("拒绝本机路径通过 .. 逃出会话根目录", () => {
    expect(isInsideSessionRoot("C:\\work\\projects\\..\\private\\session.jsonl", "C:\\work\\projects", "local")).toBe(false);
    expect(() => assertSessionFileInside(
      "C:\\work\\projects\\..\\private\\session.jsonl",
      "C:\\work\\projects",
      "local",
      "越界"
    )).toThrow("越界");
  });

  it("允许本机和 WSL 根目录下的正常会话文件", () => {
    expect(() => assertSessionFileInside(
      "C:\\work\\projects\\project-a\\session.jsonl",
      "C:\\work\\projects",
      "local",
      "越界"
    )).not.toThrow();
    expect(() => assertSessionFileInside(
      "/home/me/.claude/projects/project-a/session.jsonl",
      "/home/me/.claude/projects",
      "wsl",
      "越界"
    )).not.toThrow();
  });

  it("拒绝 WSL 路径通过 .. 逃出会话根目录", () => {
    expect(isInsideSessionRoot("/home/me/.claude/projects/../private/session.jsonl", "/home/me/.claude/projects", "wsl")).toBe(false);
    expect(() => assertSessionFileInside(
      "/home/me/.claude/projects/../private/session.jsonl",
      "/home/me/.claude/projects",
      "wsl",
      "越界"
    )).toThrow("越界");
  });
});
