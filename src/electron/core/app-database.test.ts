import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSession } from "../types";

const sqliteMock = vi.hoisted(() => {
  type CacheRow = {
    rowid: number;
    cache_key: string;
    file_path: string;
    mtime_ms: number;
    size: number;
    session_json: string;
    cached_at: string;
  };
  type State = { cache: CacheRow[]; nextRowId: number };
  const states = new Map<string, State>();
  const stateFor = (location: string) => {
    let state = states.get(location);
    if (!state) {
      state = { cache: [], nextRowId: 1 };
      states.set(location, state);
    }
    return state;
  };
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

  class Statement {
    constructor(private state: State, private source: string) {}
    all(...params: unknown[]) {
      const sql = normalize(this.source);
      if (sql.startsWith("SELECT file_path, mtime_ms, size, session_json FROM session_cache")) {
        return this.state.cache
          .filter((row) => row.cache_key === params[0])
          .map(({ file_path, mtime_ms, size, session_json }) => ({ file_path, mtime_ms, size, session_json }));
      }
      if (sql.startsWith("SELECT rowid, LENGTH(session_json) AS payload_bytes FROM session_cache")) {
        return [...this.state.cache]
          .sort((left, right) => left.cached_at.localeCompare(right.cached_at) || left.rowid - right.rowid)
          .map((row) => ({ rowid: row.rowid, payload_bytes: Buffer.byteLength(row.session_json, "utf8") }));
      }
      throw new Error(`Unsupported all SQL: ${sql}`);
    }
    get() {
      const sql = normalize(this.source);
      if (sql.includes("COUNT(DISTINCT cache_key)") || sql.startsWith("SELECT COUNT(*) AS entry_count, 0 AS cache_key_count")) {
        return {
          entry_count: this.state.cache.length,
          cache_key_count: sql.includes("COUNT(DISTINCT cache_key)")
            ? new Set(this.state.cache.map((row) => row.cache_key)).size
            : 0,
          payload_bytes: this.state.cache.reduce((total, row) => total + Buffer.byteLength(row.session_json, "utf8"), 0)
        };
      }
      if (sql.startsWith("SELECT COUNT(*) AS entry_count FROM session_metadata")) return { entry_count: 0 };
      throw new Error(`Unsupported get SQL: ${sql}`);
    }
    run(...params: unknown[]) {
      const sql = normalize(this.source);
      if (sql === "DELETE FROM session_cache WHERE cache_key = ?") {
        this.state.cache = this.state.cache.filter((row) => row.cache_key !== params[0]);
      } else if (sql.startsWith("INSERT INTO session_cache")) {
        this.state.cache.push({
          rowid: this.state.nextRowId++,
          cache_key: String(params[0]),
          file_path: String(params[1]),
          mtime_ms: Number(params[2]),
          size: Number(params[3]),
          session_json: String(params[4]),
          cached_at: String(params[5])
        });
      } else if (sql === "DELETE FROM session_cache WHERE rowid = ?") {
        this.state.cache = this.state.cache.filter((row) => row.rowid !== params[0]);
      } else {
        throw new Error(`Unsupported run SQL: ${sql}`);
      }
      return { changes: 1, lastInsertRowid: 0 };
    }
  }

  class DatabaseSync {
    private state: State;
    constructor(location: string) {
      this.state = stateFor(location);
    }
    exec() {}
    prepare(sql: string) {
      return new Statement(this.state, sql);
    }
    close() {}
  }

  return { DatabaseSync, states };
});

vi.mock("node:sqlite", () => ({ DatabaseSync: sqliteMock.DatabaseSync }));

import {
  getAppDatabaseDiagnostics,
  readSessionCache,
  replaceSessionCache,
  setSessionDatabasePath,
  type SessionCacheEntry
} from "./app-database";

let databasePath = "";

function session(id: string, text = ""): CodexSession {
  return { id, title: id, filePath: `/sessions/${id}.jsonl`, messageCount: 1, preview: [{ role: "user", text }] };
}

function entry(index: number, text = ""): SessionCacheEntry {
  const filePath = `/sessions/${index}.jsonl`;
  return { filePath, mtimeMs: index, size: 1, session: session(String(index), text) };
}

beforeEach(() => {
  databasePath = `/tmp/app-database-${crypto.randomUUID()}.db`;
  setSessionDatabasePath(databasePath);
});

describe("session cache capacity", () => {
  it("超出条数上限时淘汰最早缓存，并提供诊断统计", async () => {
    const entries = Object.fromEntries(Array.from({ length: 4_001 }, (_, index) => {
      const value = entry(index);
      return [value.filePath, value];
    }));

    await replaceSessionCache("sessions:test", entries);

    const cached = await readSessionCache("sessions:test");
    expect(Object.keys(cached)).toHaveLength(4_000);
    expect(cached["/sessions/0.jsonl"]).toBeUndefined();
    const diagnostics = await getAppDatabaseDiagnostics();
    expect(diagnostics.sessionCacheEntries).toBe(4_000);
    expect(diagnostics.sessionCacheKeys).toBe(1);
    expect(diagnostics.sessionCacheBytes).toBeGreaterThan(0);
  });

  it("不缓存超过单条上限的会话 JSON", async () => {
    const oversized = entry(1, "x".repeat(1024 * 1024));

    await replaceSessionCache("sessions:oversized", { [oversized.filePath]: oversized });

    await expect(readSessionCache("sessions:oversized")).resolves.toEqual({});
  });
});
