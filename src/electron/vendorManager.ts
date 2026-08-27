import { safeStorage } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ApiVendor,
  ApiVendorConfigTemplate,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorInput,
  CodexTarget,
  VendorModel
} from "./types";
import { assertAllowedConfigPath } from "../shared/shellArgs";
import { runWslShell, shellQuote } from "./wslProcess";
import { logGatewayEvent } from "./gatewayLog";
import {
  readAppDatabase,
  setSessionDatabasePath,
  type SqliteDatabase,
  updateAppDatabase
} from "./appDatabase";

type StoredApiVendor = Omit<ApiVendor, "apiKey"> & {
  apiKey: string;
  apiKeyEncrypted?: boolean;
};

type VendorRow = {
  id: string;
  provider_id: ApiVendor["providerId"];
  name: string;
  api_key: string;
  api_key_encrypted: number;
  api_base_url: string;
  write_common_config: number;
  enabled: number | null;
  created_at: string;
  updated_at: string;
  last_enabled_at: string | null;
};

type VendorConfigRow = {
  id: string;
  vendor_id: string;
  provider_id: ApiVendor["providerId"];
  label: string | null;
  enabled: number;
  target_path: string;
  content: string;
  sort_order: number;
};

let vendorBackupRoot = "";
let vendorDatabasePath = "";
let vendorSchemaPath = "";
let vendorSchemaPromise: Promise<void> | null = null;
const CODEX_DEFAULT_MODEL_PROVIDER = "akim";

export function setVendorDatabasePath(filePath: string, backupRoot: string) {
  setSessionDatabasePath(filePath);
  vendorDatabasePath = filePath;
  vendorBackupRoot = backupRoot;
  if (vendorSchemaPath !== filePath) vendorSchemaPromise = null;
}

// 当系统不可用 OS 级加密（如无 keyring 的 Linux）时，API Key 只能明文落盘。
// 暴露此状态供 UI 提前告警，避免用户误以为密钥已加密。
export function isApiKeyEncryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

export async function listApiVendors(target?: CodexTarget | null): Promise<ApiVendor[]> {
  await ensureVendorSchema();
  return readAppDatabase((db) => {
    const rows = target
      ? db.prepare("SELECT * FROM api_vendors WHERE provider_id = ? ORDER BY updated_at DESC").all(target.provider)
      : db.prepare("SELECT * FROM api_vendors ORDER BY updated_at DESC").all();
    return (rows as VendorRow[]).map((row) => rowToVendor(db, row));
  });
}

export async function listApiVendorSummaries(target?: CodexTarget | null): Promise<ApiVendor[]> {
  const vendors = await listApiVendors(target);
  return vendors.map((vendor) => ({ ...vendor, apiKey: "" }));
}

export async function saveApiVendor(input: ApiVendorInput): Promise<ApiVendor> {
  const normalized = normalizeVendorInput(input, Boolean(input.id));
  const now = new Date().toISOString();
  let saved: ApiVendor | null = null;

  await ensureVendorSchema();
  await updateAppDatabase((db) => {
    const existing = normalized.id
      ? db.prepare("SELECT * FROM api_vendors WHERE id = ?").get(normalized.id) as VendorRow | undefined
      : undefined;
    const existingVendor = existing ? rowToVendor(db, existing) : undefined;
    const duplicate = db.prepare("SELECT id FROM api_vendors WHERE name_norm = ? AND id <> ?")
      .get(normalizeVendorName(normalized.name), existing?.id || "") as { id: string } | undefined;
    if (duplicate) throw new Error(`供应商名称已存在：${normalized.name}`);
    const next: ApiVendor = {
      id: existing?.id || crypto.randomUUID(),
      providerId: normalized.providerId,
      name: normalized.name,
      apiKey: normalized.apiKey || existingVendor?.apiKey || "",
      apiBaseUrl: normalized.apiBaseUrl,
      writeCommonConfig: normalized.writeCommonConfig,
      configs: normalized.configs,
      enabled: existing?.enabled === 1,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      lastEnabledAt: existing?.last_enabled_at || undefined
    };
    saved = next;
    const stored = encodeVendor(next);
    db.prepare(`
      INSERT INTO api_vendors (
        id, provider_id, name, name_norm, api_key, api_key_encrypted, api_base_url,
        write_common_config, enabled, created_at, updated_at, last_enabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id = excluded.provider_id,
        name = excluded.name,
        name_norm = excluded.name_norm,
        api_key = excluded.api_key,
        api_key_encrypted = excluded.api_key_encrypted,
        api_base_url = excluded.api_base_url,
        write_common_config = excluded.write_common_config,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        last_enabled_at = excluded.last_enabled_at
    `).run(
      stored.id,
      stored.providerId,
      stored.name,
      normalizeVendorName(stored.name),
      stored.apiKey,
      stored.apiKeyEncrypted ? 1 : 0,
      stored.apiBaseUrl,
      stored.writeCommonConfig ? 1 : 0,
      stored.enabled ? 1 : 0,
      stored.createdAt,
      stored.updatedAt,
      stored.lastEnabledAt || null
    );
    db.prepare("DELETE FROM api_vendor_configs WHERE vendor_id = ?").run(stored.id);
    stored.configs.forEach((config, index) => {
      db.prepare(`
        INSERT INTO api_vendor_configs (
          id, vendor_id, provider_id, label, enabled, target_path, content, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        // 配置 id 在表中是全局主键；供应商复制或导入时不能复用外部 id。
        crypto.randomUUID(),
        stored.id,
        config.providerId,
        config.label || null,
        config.enabled ? 1 : 0,
        config.targetPath,
        config.content,
        index
      );
    });
  });

  return saved!;
}

export async function deleteApiVendor(vendorId: string) {
  await ensureVendorSchema();
  await updateAppDatabase((db) => {
    db.prepare("DELETE FROM api_vendors WHERE id = ?").run(vendorId);
  });
  return { deleted: true };
}

export async function enableApiVendor(request: ApiVendorEnableRequest, target?: CodexTarget | null): Promise<ApiVendorEnableResult> {
  const vendors = await listApiVendors(target);
  const vendor = vendors.find((item) => item.id === request.vendorId);
  if (!vendor) throw new Error("供应商不存在。");
  const configs = vendor.configs;
  if (configs.length === 0) throw new Error("请至少启用一个配置文件。");

  const enabledAt = new Date().toISOString();
  const backupRoot = path.join(vendorBackupRoot, safeName(vendor.name), enabledAt.replace(/[:.]/g, "-"));
  const written: string[] = [];

  for (const config of configs) {
    assertAllowedConfigPath(config.targetPath);
    const template = normalizeConfigContent(config.providerId, config.targetPath, config.content);
    const content = renderTemplate(template, vendor);
    if (!content.trim()) throw new Error(`配置文件内容为空，已中止写入：${config.targetPath}`);
    if (target?.kind === "wsl") {
      await writeWslConfig(target.distro!, config.targetPath, content, backupRoot);
    } else {
      await writeLocalConfig(config.targetPath, content, backupRoot);
    }
    written.push(config.targetPath);
  }

  await ensureVendorSchema();
  await updateAppDatabase((db) => {
    db.prepare("UPDATE api_vendors SET enabled = 0 WHERE provider_id = ?").run(vendor.providerId);
    db.prepare("UPDATE api_vendors SET enabled = 1, last_enabled_at = ?, updated_at = ? WHERE id = ?")
      .run(enabledAt, enabledAt, vendor.id);
  });

  return { vendorId: vendor.id, written, backupRoot };
}

function normalizeVendorInput(input: ApiVendorInput, allowEmptyApiKey = false): ApiVendorInput {
  const name = input.name.trim();
  const apiKey = input.apiKey.trim();
  const apiBaseUrl = input.apiBaseUrl.trim();
  if (!name) throw new Error("供应商名称不能为空。");
  if (!apiKey && !allowEmptyApiKey) throw new Error("API Key 不能为空。");
  if (!apiBaseUrl) throw new Error("API 请求地址不能为空。");
  const configs = input.configs.map((config) => ({
    // 配置行 ID 是数据库全局主键，不能复用 renderer 默认模板的固定 ID。
    id: crypto.randomUUID(),
    providerId: config.providerId,
    label: config.label?.trim().slice(0, 60) || undefined,
    enabled: config.enabled,
    targetPath: config.targetPath.trim(),
    content: normalizeConfigContent(config.providerId, config.targetPath, config.content)
  }));
  configs.forEach((config) => assertAllowedConfigPath(config.targetPath));
  return {
    id: input.id,
    providerId: input.providerId,
    name: name.slice(0, 80),
    apiKey,
    apiBaseUrl,
    writeCommonConfig: input.writeCommonConfig === true,
    configs
  };
}

export async function readApiVendorConfigFiles(
  request: ApiVendorConfigReadRequest,
  target?: CodexTarget | null
): Promise<ApiVendorConfigReadResult> {
  const files = await Promise.all(
    request.paths.map(async (filePath) => {
      assertAllowedConfigPath(filePath);
      const content = target?.kind === "wsl"
        ? await readWslConfig(target.distro!, filePath)
        : await readLocalConfig(filePath);
      return { path: filePath, content };
    })
  );
  return { files };
}

function encodeVendor(vendor: ApiVendor): StoredApiVendor {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      ...vendor,
      apiKey: safeStorage.encryptString(vendor.apiKey).toString("base64"),
      apiKeyEncrypted: true
    };
  }
  return { ...vendor, apiKeyEncrypted: false };
}

function decodeVendor(vendor: StoredApiVendor): ApiVendor {
  if (!vendor.apiKeyEncrypted) return vendor;
  try {
    return {
      ...vendor,
      apiKey: safeStorage.decryptString(Buffer.from(vendor.apiKey, "base64"))
    };
  } catch (error) {
    // 解密失败通常因系统账户/密钥链变更（重装、换用户、跨机迁移）。静默返回空 Key 会让
    // 网关返回 503 且用户无从分辨原因，这里打事件日志便于排障，UI 侧另行提示重新输入。
    logGatewayEvent("error", "vendor-decrypt-failed", {
      vendorId: vendor.id,
      provider: vendor.providerId,
      name: vendor.name,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ...vendor, apiKey: "" };
  }
}

function normalizeVendorName(value: string) {
  return value.trim().toLocaleLowerCase();
}

function renderTemplate(content: string, vendor: ApiVendor) {
  return content
    .replace(/\{\{API_KEY\}\}/g, vendor.apiKey)
    .replace(/\{\{BASE_URL\}\}/g, vendor.apiBaseUrl)
    .replace(/\{\{VENDOR_NAME\}\}/g, vendor.name);
}

function normalizeConfigContent(providerId: ApiVendor["providerId"], targetPath: string, content: string) {
  if (content.trim()) return content;
  return defaultConfigContent(providerId, targetPath) || content;
}

function defaultConfigContent(providerId: ApiVendor["providerId"], targetPath: string) {
  const normalizedPath = targetPath.replace(/\\/g, "/");
  if (providerId === "codex" && normalizedPath.endsWith("/auth.json")) {
    return JSON.stringify({ OPENAI_API_KEY: "{{API_KEY}}" }, null, 2);
  }
  if (providerId === "codex" && normalizedPath.endsWith("/config.toml")) {
    return [
      `model_provider = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
      "",
      `[model_providers.${CODEX_DEFAULT_MODEL_PROVIDER}]`,
      `name = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'base_url = "{{BASE_URL}}"'
    ].join("\n");
  }
  if (providerId === "gemini" && normalizedPath.endsWith("/.env")) {
    return [
      "GEMINI_API_KEY={{API_KEY}}",
      "GOOGLE_GEMINI_BASE_URL={{BASE_URL}}"
    ].join("\n");
  }
  if (providerId === "gemini" && normalizedPath.endsWith("/settings.json")) {
    return JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }, null, 2);
  }
  if (providerId === "claude" && normalizedPath.endsWith("/settings.json")) {
    return JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "{{BASE_URL}}",
        ANTHROPIC_AUTH_TOKEN: "{{API_KEY}}"
      },
      theme: "dark"
    }, null, 2);
  }
  return "";
}


async function writeLocalConfig(targetPath: string, content: string, backupRoot: string) {
  const destination = resolveLocalHomePath(targetPath);
  const backupPath = path.join(backupRoot, "local", safeName(destination));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(destination, backupPath).catch(() => undefined);
  await fs.writeFile(destination, content, "utf8");
}

async function writeWslConfig(distro: string, targetPath: string, content: string, backupRoot: string) {
  if (!distro) throw new Error("当前 WSL 目标缺少 distro。");
  const backupPath = path.join(backupRoot, `wsl-${safeName(distro)}`, safeName(targetPath));
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  const script = [
    "set -e",
    `target=${shellQuote(targetPath)}`,
    `content=${shellQuote(encodedContent)}`,
    'case "$target" in "~/"*) target="$HOME/${target#\\~/}" ;; "\\$HOME/"*) target="$HOME/${target#\\$HOME/}" ;; esac',
    "mkdir -p -- \"$(dirname \"$target\")\"",
    "if [ -f \"$target\" ]; then cat -- \"$target\"; fi",
    "printf %s \"$content\" | base64 -d > \"$target\""
  ].join("\n");
  const previous = await runWslShell(distro, script);
  if (previous) await fs.writeFile(backupPath, previous, "utf8");
}

async function readLocalConfig(targetPath: string) {
  return fs.readFile(resolveLocalHomePath(targetPath), "utf8").catch(() => "");
}

async function readWslConfig(distro: string, targetPath: string) {
  if (!distro) throw new Error("当前 WSL 目标缺少 distro。");
  const script = [
    "set -e",
    `target=${shellQuote(targetPath)}`,
    'case "$target" in "~/"*) target="$HOME/${target#\\~/}" ;; "\\$HOME/"*) target="$HOME/${target#\\$HOME/}" ;; esac',
    'if [ -f "$target" ]; then cat -- "$target"; fi'
  ].join("\n");
  return runWslShell(distro, script);
}

function resolveLocalHomePath(filePath: string) {
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  if (filePath.startsWith("$HOME/")) return path.join(os.homedir(), filePath.slice("$HOME/".length));
  return filePath;
}

async function ensureVendorSchema() {
  if (!vendorDatabasePath) throw new Error("供应商数据库路径未初始化。");
  if (vendorSchemaPath === vendorDatabasePath) return;
  if (!vendorSchemaPromise) {
    const expectedPath = vendorDatabasePath;
    vendorSchemaPromise = updateAppDatabase((db) => initializeVendorDb(db)).then(() => {
      vendorSchemaPath = expectedPath;
    }).finally(() => {
      vendorSchemaPromise = null;
    });
  }
  await vendorSchemaPromise;
}

function initializeVendorDb(db: SqliteDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS api_vendors (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      api_key TEXT NOT NULL,
      api_key_encrypted INTEGER NOT NULL DEFAULT 0,
      api_base_url TEXT NOT NULL,
      write_common_config INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_enabled_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_vendors_name_norm
      ON api_vendors(name_norm);

    CREATE TABLE IF NOT EXISTS api_vendor_configs (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      target_path TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (vendor_id) REFERENCES api_vendors(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_api_vendor_configs_vendor_id
      ON api_vendor_configs(vendor_id, sort_order);
  `);
}

function rowToVendor(db: SqliteDatabase, row: VendorRow): ApiVendor {
  const stored: StoredApiVendor = {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    apiKey: row.api_key,
    apiKeyEncrypted: row.api_key_encrypted === 1,
    apiBaseUrl: row.api_base_url,
    writeCommonConfig: row.write_common_config === 1,
    configs: listVendorConfigs(db, row.id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEnabledAt: row.last_enabled_at || undefined
  };
  return decodeVendor(stored);
}

function listVendorConfigs(db: SqliteDatabase, vendorId: string): ApiVendorConfigTemplate[] {
  const rows = db.prepare("SELECT * FROM api_vendor_configs WHERE vendor_id = ? ORDER BY sort_order, id").all(vendorId);
  return (rows as VendorConfigRow[]).map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    label: row.label || undefined,
    enabled: row.enabled === 1,
    targetPath: row.target_path,
    content: row.content
  }));
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 100) || "vendor";
}

const MODEL_LIST_TIMEOUT_MS = 10_000;

export async function listVendorModels(vendorId: string): Promise<VendorModel[]> {
  const vendors = await listApiVendors();
  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) throw new Error("供应商不存在。");
  if (!vendor.apiBaseUrl) throw new Error("供应商未配置 API 地址。");

  const baseUrl = new URL(vendor.apiBaseUrl);
  // 中转站的地址可能填写为根地址、/v1 或 /openai/v1；按顺序尝试候选地址，保留已有路径前缀。
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const modelUrls = [...new Set([
    /\/models$/i.test(basePath) ? basePath : `${basePath || ""}/models`,
    /\/v\d+(?:\.\d+)?$/i.test(basePath) || /\/models$/i.test(basePath) ? "" : `${basePath || ""}/v1/models`
  ].filter(Boolean).map((pathname) => new URL(pathname, baseUrl.origin).toString()))];
  const headers: Record<string, string> = { accept: "application/json" };
  if (vendor.apiKey) headers.authorization = `Bearer ${vendor.apiKey}`;
  if (vendor.providerId === "claude") headers["x-api-key"] = vendor.apiKey;
  if (vendor.providerId === "gemini") headers["x-goog-api-key"] = vendor.apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    let lastError = "获取模型列表失败。";
    for (const modelsUrl of modelUrls) {
      const response = await fetch(modelsUrl, { headers, signal: controller.signal });
      if (!response.ok) {
        lastError = `获取模型列表失败 (${response.status})`;
        if (response.status === 404 || response.status === 405) continue;
        throw new Error(lastError);
      }
      const body = await response.json() as unknown;
      const raw = extractModelRows(body);
      return raw.map((item) => ({
      id: String(item.id || item.name || item.model || ""),
      object: typeof item.object === "string" ? item.object : undefined,
      ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
      created: typeof item.created === "number" ? item.created : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      pricingMultiplier: typeof item.pricingMultiplier === "number" ? item.pricingMultiplier : undefined,
      tags: Array.isArray(item.tags) ? (item.tags as string[]).filter((t): t is string => typeof t === "string") : undefined
      })).filter((m) => m.id);
    }
    throw new Error(lastError);
  } finally {
    clearTimeout(timer);
  }
}

function extractModelRows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  for (const key of ["data", "models", "items", "results"]) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
