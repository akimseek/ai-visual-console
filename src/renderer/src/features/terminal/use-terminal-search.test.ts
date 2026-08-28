import { describe, expect, it, vi } from "vitest";
import type { SearchAddon } from "@xterm/addon-search";
import {
  advanceTerminalSearchResult,
  countTerminalTextMatches,
  createTerminalSearchOptions,
  formatTerminalSearchResult,
  runTerminalSearch
} from "./use-terminal-search";

describe("terminal search helpers", () => {
  it("maps case and whole-word choices to xterm search options", () => {
    const options = createTerminalSearchOptions({ caseSensitive: true, wholeWord: false });

    expect(options.caseSensitive).toBe(true);
    expect(options.wholeWord).toBe(false);
    expect(options.decorations).toMatchObject({
      matchBackground: "#334155",
      activeMatchBackground: "#d97706"
    });
  });

  it("formats xterm's zero-based active result", () => {
    expect(formatTerminalSearchResult({ resultIndex: 1, resultCount: 4 })).toBe("2/4");
    expect(formatTerminalSearchResult({ resultIndex: -1, resultCount: 4 })).toBe("0/4");
    expect(formatTerminalSearchResult({ resultIndex: -1, resultCount: 0 })).toBe("0/0");
  });

  it("falls back to undecorated search when xterm highlighting fails", () => {
    const findNext = vi.fn()
      .mockImplementationOnce(() => { throw new Error("decoration failed"); })
      .mockReturnValue(true);
    const addon = { findNext } as unknown as SearchAddon;

    expect(runTerminalSearch(addon, "next", "error", createTerminalSearchOptions({
      caseSensitive: false,
      wholeWord: false
    }))).toBe(true);
    expect(findNext).toHaveBeenCalledTimes(2);
    expect(findNext.mock.calls[1][1]).not.toHaveProperty("decorations");
  });

  it("counts overlapping, case-sensitive and whole-word matches", () => {
    expect(countTerminalTextMatches("aaaa", "aa", {})).toBe(3);
    expect(countTerminalTextMatches("Error error", "Error", { caseSensitive: true })).toBe(1);
    expect(countTerminalTextMatches("task taskbar task", "task", { wholeWord: true })).toBe(2);
  });

  it("advances and wraps the displayed result index", () => {
    expect(advanceTerminalSearchResult({ resultIndex: 0, resultCount: 3 }, 3, "next"))
      .toEqual({ resultIndex: 1, resultCount: 3 });
    expect(advanceTerminalSearchResult({ resultIndex: 0, resultCount: 3 }, 3, "previous"))
      .toEqual({ resultIndex: 2, resultCount: 3 });
    expect(advanceTerminalSearchResult({ resultIndex: -1, resultCount: 0 }, 3, "next"))
      .toEqual({ resultIndex: 0, resultCount: 3 });
  });
});
