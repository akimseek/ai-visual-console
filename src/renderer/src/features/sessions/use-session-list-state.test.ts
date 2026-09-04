import { describe, expect, it } from "vitest";
import { shouldLoadSessionList } from "./use-session-list-state";

describe("shouldLoadSessionList", () => {
  it("首次进入目标视图时允许加载", () => {
    expect(shouldLoadSessionList("codex:local", "codex:local:active", {})).toBe(true);
  });

  it("没有目标或缓存键时不加载", () => {
    expect(shouldLoadSessionList("", null, {})).toBe(false);
    expect(shouldLoadSessionList("codex:local", null, {})).toBe(false);
  });

  it("已加载的目标视图不重复加载", () => {
    expect(shouldLoadSessionList(
      "codex:local",
      "codex:local:active",
      { "codex:local:active": true }
    )).toBe(false);
  });
});
