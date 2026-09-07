import { describe, expect, it } from "vitest";
import {
  createSummarySearchResults,
  mergeContentSearchResults,
  uniqueSearchTargets,
  type GlobalSessionSearchEntry
} from "./global-session-search";

const codexTarget = { id: "codex:local", provider: "codex", label: "Codex: local", kind: "local", available: true } as const;
const claudeTarget = { id: "claude:local", provider: "claude", label: "Claude: local", kind: "local", available: true } as const;

const entries: GlobalSessionSearchEntry[] = [
  {
    target: codexTarget,
    sessions: [{
      id: "codex-session",
      title: "Fix gateway retry",
      filePath: "codex.jsonl",
      updatedAt: "2026-09-07T09:00:00.000Z",
      messageCount: 1,
      preview: []
    }]
  },
  {
    target: claudeTarget,
    sessions: [{
      id: "claude-session",
      title: "Review terminal menu",
      filePath: "claude.jsonl",
      updatedAt: "2026-09-07T10:00:00.000Z",
      messageCount: 1,
      preview: [{ role: "user", text: "Gateway details" }]
    }]
  }
];

describe("global session search helpers", () => {
  it("deduplicates cached and current targets", () => {
    expect(uniqueSearchTargets([codexTarget], codexTarget)).toEqual([codexTarget]);
  });

  it("searches summary fields and sorts by most recently updated", () => {
    expect(createSummarySearchResults(entries, "gateway").map((result) => result.session.id))
      .toEqual(["claude-session", "codex-session"]);
  });

  it("applies provider and target filters before returning results", () => {
    expect(createSummarySearchResults(entries, "gateway", "codex").map((result) => result.session.id))
      .toEqual(["codex-session"]);
    expect(createSummarySearchResults(entries, "gateway", "", claudeTarget.id).map((result) => result.session.id))
      .toEqual(["claude-session"]);
  });

  it("keeps summary matches when merging body-content matches", () => {
    const summary = createSummarySearchResults(entries, "gateway");
    const contentOnly = [{
      target: codexTarget,
      session: { ...entries[0].sessions[0], id: "content-only", title: "Unrelated", updatedAt: "2026-09-07T11:00:00.000Z" },
      source: "content" as const
    }];
    expect(mergeContentSearchResults(summary, contentOnly).map((result) => result.session.id))
      .toEqual(["content-only", "claude-session", "codex-session"]);
  });
});
