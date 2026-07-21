import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  CompressionPrompt,
  CodexSession,
  SessionMetadata,
  WorkspacePreset
} from "./types";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

type SqliteModule = {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

export type SessionCacheEntry = {
  filePath: string;
  mtimeMs: number;
  size: number;
  session: CodexSession;
};

type SessionCacheRow = {
  file_path: string;
  mtime_ms: number;
  size: number;
  session_json: string;
};

type SessionMetadataRow = {
  session_id: string;
  metadata_json: string;
};

type WorkspacePresetRow = {
  id: string;
  name: string;
  cwd: string;
  target_kind: WorkspacePreset["targetKind"];
  prompt: string | null;
  cli_args: string | null;
  updated_at: string;
};

type CompressionPromptRow = {
  id: string;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
};

let databasePath = "";
let database: SqliteDatabase | null = null;
let writeQueue = Promise.resolve();
const requireFromHere = createRequire(__filename);

export function setSessionDatabasePath(filePath: string) {
  if (databasePath !== filePath && database) {
    database.close();
    database = null;
  }
  databasePath = filePath;
}

export async function readSessionCache(cacheKey: string): Promise<Record<string, SessionCacheEntry>> {
  const db = await getDatabase();
  const rows = db.prepare(
    "SELECT file_path, mtime_ms, size, session_json FROM session_cache WHERE cache_key = ?"
  ).all(cacheKey) as SessionCacheRow[];
  const entries: Record<string, SessionCacheEntry> = {};
  for (const row of rows) {
    try {
      entries[row.file_path] = {
        filePath: row.file_path,
        mtimeMs: row.mtime_ms,
        size: row.size,
        session: JSON.parse(row.session_json) as CodexSession
      };
    } catch {
      // 缓存损坏时忽略单条记录，下一次扫描会自动重建。
    }
  }
  return entries;
}

export async function replaceSessionCache(cacheKey: string, entries: Record<string, SessionCacheEntry>) {
  await updateDatabase((db) => {
    db.prepare("DELETE FROM session_cache WHERE cache_key = ?").run(cacheKey);
    const insert = db.prepare(`
      INSERT INTO session_cache (cache_key, file_path, mtime_ms, size, session_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const entry of Object.values(entries)) {
      insert.run(cacheKey, entry.filePath, entry.mtimeMs, entry.size, JSON.stringify(entry.session));
    }
  });
}

export async function removeSessionCacheEntries(cacheKey: string, filePaths: string[]) {
  if (filePaths.length === 0) return;
  await updateDatabase((db) => {
    const remove = db.prepare("DELETE FROM session_cache WHERE cache_key = ? AND file_path = ?");
    for (const filePath of filePaths) remove.run(cacheKey, filePath);
  });
}

export async function readSessionMetadata(targetId: string, sessionId: string): Promise<SessionMetadata> {
  const db = await getDatabase();
  const rows = db.prepare(
    "SELECT session_id, metadata_json FROM session_metadata WHERE target_id = ? AND session_id = ?"
  ).all(targetId, sessionId) as SessionMetadataRow[];
  return rows[0] ? parseMetadata(rows[0].metadata_json) : {};
}

export async function readSessionMetadataMap(targetId: string): Promise<Record<string, SessionMetadata>> {
  const db = await getDatabase();
  const rows = db.prepare(
    "SELECT session_id, metadata_json FROM session_metadata WHERE target_id = ?"
  ).all(targetId) as SessionMetadataRow[];
  return Object.fromEntries(rows.map((row) => [row.session_id, parseMetadata(row.metadata_json)]));
}

export async function saveSessionMetadata(targetId: string, sessionId: string, metadata: SessionMetadata) {
  await updateDatabase((db) => {
    db.prepare(`
      INSERT INTO session_metadata (target_id, session_id, metadata_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(target_id, session_id) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(targetId, sessionId, JSON.stringify(metadata), metadata.updatedAt || new Date().toISOString());
  });
}

export async function deleteSessionMetadataRecord(targetId: string, sessionId: string) {
  await updateDatabase((db) => {
    db.prepare("DELETE FROM session_metadata WHERE target_id = ? AND session_id = ?").run(targetId, sessionId);
  });
}

export async function importSessionMetadata(
  entries: Array<{ targetId: string; sessionId: string; metadata: SessionMetadata }>
) {
  if (entries.length === 0) return;
  await updateDatabase((db) => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO session_metadata (target_id, session_id, metadata_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const entry of entries) {
      insert.run(
        entry.targetId,
        entry.sessionId,
        JSON.stringify(entry.metadata),
        entry.metadata.updatedAt || new Date().toISOString()
      );
    }
  });
}

export function hasAppDatabase() {
  return Boolean(databasePath);
}

export async function listWorkspacePresetRecords(): Promise<WorkspacePreset[]> {
  const db = await getDatabase();
  const rows = db.prepare("SELECT * FROM workspace_presets ORDER BY updated_at DESC").all() as WorkspacePresetRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    targetKind: row.target_kind,
    prompt: row.prompt || undefined,
    cliArgs: row.cli_args || undefined,
    updatedAt: row.updated_at
  }));
}

export async function saveWorkspacePresetRecord(preset: WorkspacePreset) {
  await updateDatabase((db) => {
    db.prepare(`
      INSERT INTO workspace_presets (id, name, cwd, target_kind, prompt, cli_args, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cwd = excluded.cwd,
        target_kind = excluded.target_kind,
        prompt = excluded.prompt,
        cli_args = excluded.cli_args,
        updated_at = excluded.updated_at
    `).run(
      preset.id,
      preset.name,
      preset.cwd,
      preset.targetKind || null,
      preset.prompt || null,
      preset.cliArgs || null,
      preset.updatedAt
    );
  });
}

export async function deleteWorkspacePresetRecord(presetId: string) {
  await updateDatabase((db) => {
    db.prepare("DELETE FROM workspace_presets WHERE id = ?").run(presetId);
  });
}

export async function listCompressionPromptRecords(): Promise<CompressionPrompt[]> {
  const db = await getDatabase();
  const rows = db.prepare("SELECT * FROM compression_prompts ORDER BY updated_at DESC").all() as CompressionPromptRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function saveCompressionPromptRecord(prompt: CompressionPrompt) {
  await updateDatabase((db) => {
    db.prepare(`
      INSERT INTO compression_prompts (id, name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(prompt.id, prompt.name, prompt.content, prompt.createdAt, prompt.updatedAt);
  });
}

export async function deleteCompressionPromptRecord(promptId: string) {
  await updateDatabase((db) => {
    db.prepare("DELETE FROM compression_prompts WHERE id = ?").run(promptId);
  });
}

async function getDatabase() {
  if (!databasePath) throw new Error("会话数据库路径未初始化。");
  if (database) return database;
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS session_cache (
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      session_json TEXT NOT NULL,
      PRIMARY KEY (cache_key, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_session_cache_key
      ON session_cache(cache_key);

    CREATE TABLE IF NOT EXISTS session_metadata (
      target_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (target_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_metadata_updated_at
      ON session_metadata(updated_at);

    CREATE TABLE IF NOT EXISTS workspace_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      target_kind TEXT,
      prompt TEXT,
      cli_args TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_presets_updated_at
      ON workspace_presets(updated_at);

    CREATE TABLE IF NOT EXISTS compression_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compression_prompts_updated_at
      ON compression_prompts(updated_at);
  `);
  return database;
}

function parseMetadata(content: string): SessionMetadata {
  try {
    return JSON.parse(content) as SessionMetadata;
  } catch {
    return {};
  }
}

function loadSqlite(): SqliteModule {
  try {
    return requireFromHere("node:sqlite") as SqliteModule;
  } catch (error: any) {
    throw new Error(
      `当前 Electron/Node 运行时不支持 node:sqlite，无法使用会话数据库：${error?.message || error}`,
      { cause: error }
    );
  }
}

async function updateDatabase(updater: (db: SqliteDatabase) => void) {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      updater(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  await writeQueue;
}
