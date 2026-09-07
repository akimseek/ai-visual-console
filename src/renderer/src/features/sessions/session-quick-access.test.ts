import { describe, expect, it } from "vitest";
import type { SessionQuickAccessItem } from "../../types";
import { normalizeSessionQuickAccess } from "./session-quick-access";

function item(id: string, targetId = "codex:local", favorite = false): SessionQuickAccessItem {
  return {
    target: { id: targetId, provider: "codex", label: targetId, kind: "local", available: true },
    session: { id, title: id, filePath: `${id}.jsonl`, messageCount: 0, preview: [] },
    favorite
  };
}

describe("normalizeSessionQuickAccess", () => {
  it("keeps unique favorites and excludes them from recent sessions", () => {
    const favorite = item("same", "wsl:Ubuntu", true);
    const result = normalizeSessionQuickAccess({
      favorites: [favorite, favorite],
      recent: [favorite, item("recent")]
    });

    expect(result.favorites).toEqual([favorite]);
    expect(result.recent).toEqual([item("recent")]);
  });
});
