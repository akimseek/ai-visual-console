import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { AiSession } from "../../types";
import { createSessionActions } from "./use-session-actions";

const session = { id: "session-1", title: "会话", filePath: "/tmp/session.jsonl" } as AiSession;

function stateSetter<T>(initial: T) {
  let value = initial;
  const setter = ((next: SetStateAction<T>) => {
    value = typeof next === "function" ? (next as (current: T) => T)(value) : next;
  }) as Dispatch<SetStateAction<T>>;
  return { get: () => value, setter };
}

function createActions(overrides: Partial<Parameters<typeof createSessionActions>[0]> = {}) {
  const activeSessions = stateSetter<AiSession[]>([session]);
  const trashSessions = stateSetter<AiSession[]>([session]);
  const selectedId = stateSetter(session.id);
  const selectedDetails = stateSetter<AiSession | null>(session);
  const selectedBatchIds = stateSetter<string[]>([session.id]);
  const calls: string[] = [];
  const closeOpenSessionTerminal = vi.fn(async () => {
    calls.push("close");
  });
  const codexConsole = {
    deleteSession: vi.fn(async () => {
      calls.push("delete");
    }),
    restoreSession: vi.fn(async () => {
      calls.push("restore");
    }),
    purgeSession: vi.fn(async () => undefined),
    deleteSessions: vi.fn(async () => undefined),
    purgeSessions: vi.fn(async () => undefined)
  };
  vi.stubGlobal("window", { confirm: vi.fn(() => true), codexConsole });

  const actions = createSessionActions({
    targetId: "codex:local",
    view: "active",
    selectedBatchIds: [session.id],
    selectedBatchSessions: [session],
    activeViewLoaded: true,
    closeOpenSessionTerminal,
    updateCachedSessions: (_targetId, view, updater) => {
      const state = view === "active" ? activeSessions : trashSessions;
      state.setter((current) => updater(current));
    },
    invalidateLoadedView: vi.fn(),
    loadSessions: vi.fn(async () => undefined),
    mergeSession: (sessions, nextSession) => [nextSession, ...sessions.filter((item) => item.id !== nextSession.id)],
    runWorkspaceAction: async (_message, action) => {
      await action();
    },
    setSelectedId: selectedId.setter,
    setSelectedSessionDetails: selectedDetails.setter,
    setSelectedBatchIds: selectedBatchIds.setter,
    setNotice: vi.fn(),
    ...overrides
  });

  return { actions, activeSessions, trashSessions, selectedId, selectedDetails, selectedBatchIds, calls, codexConsole };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session actions", () => {
  it("删除会话前先关闭终端，并清理活动缓存与当前详情", async () => {
    const fixture = createActions();

    await fixture.actions.deleteSessionById(session);

    expect(fixture.calls).toEqual(["close", "delete"]);
    expect(fixture.activeSessions.get()).toEqual([]);
    expect(fixture.selectedId.get()).toBe("");
    expect(fixture.selectedDetails.get()).toBeNull();
  });

  it("批量恢复按选中顺序执行并更新两个视图缓存", async () => {
    const fixture = createActions();

    await fixture.actions.restoreSelectedBatch();

    expect(fixture.codexConsole.restoreSession).toHaveBeenCalledWith("codex:local", session.id);
    expect(fixture.trashSessions.get()).toEqual([]);
    expect(fixture.activeSessions.get()).toEqual([session]);
    expect(fixture.selectedBatchIds.get()).toEqual([]);
  });
});
