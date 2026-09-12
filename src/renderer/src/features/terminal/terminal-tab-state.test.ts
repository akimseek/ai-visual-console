import { describe, expect, it } from "vitest";
import { applyTerminalStatus, omitTerminalTabRecords, removeTerminalTabs, type TerminalTab, upsertTerminalTab } from "./terminal-tab-state";

const target = { id: "codex:local", provider: "codex", label: "本地", kind: "local", available: true } as const;

const tabs: TerminalTab[] = [
  { key: "a", targetId: "codex:local", target, title: "A" },
  { key: "b", targetId: "codex:local", target, title: "B" },
  { key: "c", targetId: "codex:local", target, title: "C" }
];

describe("terminal tab state", () => {
  it("打开已有标签时保留位置并使用最新会话快照", () => {
    const next = upsertTerminalTab(tabs, { key: "b", targetId: "codex:local", target, title: "B2" });
    expect(next.map((tab) => tab.key)).toEqual(["a", "b", "c"]);
    expect(next[1].title).toBe("B2");
    expect(upsertTerminalTab(tabs, { key: "d", targetId: "codex:local", target, title: "D" }).map((tab) => tab.key)).toEqual([
      "a",
      "b",
      "c",
      "d"
    ]);
  });

  it("为跨平台标签保留独立的目标快照", () => {
    const wslTarget = { id: "gemini:wsl:Ubuntu", provider: "gemini", label: "Ubuntu", kind: "wsl", distro: "Ubuntu", available: true } as const;
    const next = upsertTerminalTab(tabs, { key: "wsl", targetId: wslTarget.id, target: wslTarget, title: "WSL" });
    expect(next.at(-1)?.target).toEqual(wslTarget);
  });

  it("关闭标签时保留顺序并选择相邻回退标签", () => {
    const result = removeTerminalTabs(tabs, new Set(["b"]));
    expect(result.tabs.map((tab) => tab.key)).toEqual(["a", "c"]);
    expect(result.fallback?.key).toBe("a");
  });

  it("批量关闭和不存在的键不会破坏状态", () => {
    expect(removeTerminalTabs(tabs, new Set(["a", "c"])).fallback?.key).toBe("b");
    expect(removeTerminalTabs(tabs, new Set(["missing"])).tabs).toBe(tabs);
    const records = { a: "one", b: "two" };
    expect(omitTerminalTabRecords(records, new Set(["a"]))).toEqual({ b: "two" });
    expect(omitTerminalTabRecords(records, new Set(["missing"]))).toBe(records);
  });

  it("为每个标签独立维护提醒状态并支持标记已读", () => {
    const completed = applyTerminalStatus(undefined, {
      terminalId: "terminal-a",
      turnId: 1,
      status: "completed",
      attention: { kind: "completed", title: "本轮已完成" },
      updatedAt: 1
    });
    expect(completed.unread).toBe(true);
    const read = { ...completed, unread: false };
    const repeated = applyTerminalStatus(read, {
      terminalId: "terminal-a",
      turnId: 1,
      status: "completed",
      attention: { kind: "completed", title: "本轮已完成" },
      updatedAt: 2
    });
    expect(repeated.unread).toBe(false);
    const running = applyTerminalStatus(repeated, { terminalId: "terminal-a", status: "running", updatedAt: 3 });
    expect(running).toEqual({ status: "running", unread: false, updatedAt: 3 });
  });

});
