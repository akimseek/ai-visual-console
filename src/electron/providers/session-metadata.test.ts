import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata } from "../types";

const database = vi.hoisted(() => {
  const entries = new Map<string, SessionMetadata>();
  const key = (targetId: string, sessionId: string) => `${targetId}:${sessionId}`;
  return {
    entries,
    reset: () => entries.clear(),
    hasAppDatabase: () => true,
    importSessionMetadata: async () => undefined,
    readSessionMetadata: async (targetId: string, sessionId: string) => entries.get(key(targetId, sessionId)) || {},
    readSessionMetadataMap: async () => ({}),
    readSessionIdsByParent: async () => [],
    saveSessionMetadata: async (targetId: string, sessionId: string, metadata: SessionMetadata) => {
      entries.set(key(targetId, sessionId), metadata);
    },
    deleteSessionMetadataRecord: async (targetId: string, sessionId: string) => {
      entries.delete(key(targetId, sessionId));
    },
    listSessionMetadataEntries: async () => []
  };
});

vi.mock("../core/app-database", () => database);

import {
  markSessionOpened,
  setSessionBranchMetadata,
  setSessionCustomTitle,
  setSessionFavorite
} from "./session-metadata";

beforeEach(() => {
  database.reset();
});

describe("session quick-access metadata", () => {
  it("updates favorite and recent timestamps without overwriting title or branch metadata", async () => {
    await setSessionCustomTitle("codex:local", "session-1", "重要会话");
    await setSessionBranchMetadata("codex:local", "session-1", { parentSessionId: "parent-1" });
    await setSessionFavorite("codex:local", "session-1", true);
    const metadata = await markSessionOpened("codex:local", "session-1");

    expect(metadata).toMatchObject({
      customTitle: "重要会话",
      branch: { parentSessionId: "parent-1" },
      favorite: true
    });
    expect(metadata.lastOpenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const unfavorited = await setSessionFavorite("codex:local", "session-1", false);
    expect(unfavorited).toMatchObject({
      customTitle: "重要会话",
      branch: { parentSessionId: "parent-1" },
      lastOpenedAt: metadata.lastOpenedAt
    });
    expect(unfavorited.favorite).toBeUndefined();
  });
});
