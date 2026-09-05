import { describe, expect, it } from "vitest";
import { omitTerminalTabRecords, removeTerminalTabs, type TerminalTab, upsertTerminalTab } from "./terminal-tab-state";

const tabs: TerminalTab[] = [
  { key: "a", targetId: "codex:local", title: "A" },
  { key: "b", targetId: "codex:local", title: "B" },
  { key: "c", targetId: "codex:local", title: "C" }
];

describe("terminal tab state", () => {
  it("打开已有标签时保留位置并使用最新会话快照", () => {
    const next = upsertTerminalTab(tabs, { key: "b", targetId: "codex:local", title: "B2" });
    expect(next.map((tab) => tab.key)).toEqual(["a", "b", "c"]);
    expect(next[1].title).toBe("B2");
    expect(upsertTerminalTab(tabs, { key: "d", targetId: "codex:local", title: "D" }).map((tab) => tab.key)).toEqual([
      "a",
      "b",
      "c",
      "d"
    ]);
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

});
