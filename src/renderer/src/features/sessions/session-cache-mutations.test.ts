import { describe, expect, it } from "vitest";
import type { AiSession } from "../../types";
import { applySessionCustomTitle } from "./session-cache-mutations";

function session(overrides: Partial<AiSession> = {}): AiSession {
  return {
    id: "session-1",
    title: "original-title",
    filePath: "session.jsonl",
    messageCount: 0,
    preview: [],
    ...overrides
  };
}

describe("applySessionCustomTitle", () => {
  it("preserves the original title when assigning a custom title", () => {
    const result = applySessionCustomTitle(session(), { customTitle: "custom-title" });

    expect(result.title).toBe("custom-title");
    expect(result.sourceTitle).toBe("original-title");
    expect(result.metadata?.customTitle).toBe("custom-title");
  });

  it("restores the original title and removes empty metadata", () => {
    const result = applySessionCustomTitle(
      session({ title: "custom-title", sourceTitle: "original-title", metadata: { customTitle: "custom-title" } }),
      undefined
    );

    expect(result.title).toBe("original-title");
    expect(result.sourceTitle).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it("keeps branch metadata when clearing the custom title", () => {
    const branch = { parentSessionId: "parent-1" };
    const result = applySessionCustomTitle(
      session({ title: "custom-title", sourceTitle: "original-title" }),
      { branch }
    );

    expect(result.title).toBe("original-title");
    expect(result.metadata?.branch).toEqual(branch);
  });
});
