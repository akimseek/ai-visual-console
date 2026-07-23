import { describe, expect, it } from "vitest";
import { createTerminalSearchOptions, formatTerminalSearchResult } from "./useTerminalSearch";

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
});
