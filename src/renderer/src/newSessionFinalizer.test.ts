import { describe, expect, it } from "vitest";
import { findNewSessionCandidates } from "./newSessionFinalizer";
import type { AiSession } from "./types";
import type { TerminalTab } from "./terminalTabState";

const tab: TerminalTab = { key: "new", targetId: "codex:local", title: "新会话", cwd: "/work", knownSessionIds: ["old"], createdAt: 20_000 };
const session = (id: string, updatedAt: string, cwd = "/work") => ({ id, title: id, cwd, updatedAt } as AiSession);

describe("new session finalizer", () => {
  it("仅匹配新建时间窗口内且工作目录一致的未见会话", () => {
    expect(findNewSessionCandidates([
      session("old", "1970-01-01T00:00:20.000Z"),
      session("new", "1970-01-01T00:00:20.000Z"),
      session("other-cwd", "1970-01-01T00:00:20.000Z", "/other"),
      session("too-old", "1970-01-01T00:00:00.000Z")
    ], tab).map((item) => item.id)).toEqual(["new"]);
  });
});
