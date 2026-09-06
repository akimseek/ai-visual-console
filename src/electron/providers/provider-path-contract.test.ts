import { describe, expect, it } from "vitest";
import { assertSessionFileInside, isInsideSessionRoot, relocateSessionPath } from "./session-file-ops";

describe("Provider 跨平台路径契约", () => {
  const cases = [
    {
      kind: "local" as const,
      root: "C:\\Users\\test\\.provider\\projects",
      valid: "C:\\Users\\test\\.provider\\projects\\work\\session.jsonl",
      escape: "C:\\Users\\test\\.provider\\projects\\..\\private\\session.jsonl",
      outside: "C:\\Users\\test\\.provider\\projects-backup\\session.jsonl",
      trash: "C:\\Users\\test\\.provider\\trash\\projects"
    },
    {
      kind: "wsl" as const,
      root: "/home/test/.provider/projects",
      valid: "/home/test/.provider/projects/work/session.jsonl",
      escape: "/home/test/.provider/projects/../private/session.jsonl",
      outside: "/home/test/.provider/projects-backup/session.jsonl",
      trash: "/home/test/.provider/trash/projects"
    }
  ];

  it.each(cases)("$kind 只允许会话根目录内的文件", ({ kind, root, valid, escape, outside }) => {
    expect(isInsideSessionRoot(valid, root, kind)).toBe(true);
    expect(isInsideSessionRoot(escape, root, kind)).toBe(false);
    expect(isInsideSessionRoot(outside, root, kind)).toBe(false);
    expect(() => assertSessionFileInside(root, root, kind, "越界")).toThrow("越界");
    expect(() => assertSessionFileInside(escape, root, kind, "越界")).toThrow("越界");
  });

  it.each(cases)("$kind 能保持相对路径映射到回收站", ({ kind, root, valid, trash }) => {
    expect(relocateSessionPath(valid, root, trash, kind, "越界")).toBe(
      kind === "local"
        ? "C:\\Users\\test\\.provider\\trash\\projects\\work\\session.jsonl"
        : "/home/test/.provider/trash/projects/work/session.jsonl"
    );
  });
});
