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
import {
  readAppDatabase,
  setSessionDatabasePath,
  type SqliteDatabase,
  updateAppDatabase
} from "./appDatabase";

type VendorRow = {
  id: string;
  provider_id: ApiVendor["providerId"];
  name: string;
  api_key: string;
  api_base_url: string;
  sort: number;
  input_price_usd: number | null;
  output_price_usd: number | null;
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

type VendorBalanceRow = {
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string | null;
  plan_name: string | null;
  is_valid: number;
  status: "idle" | "loading" | "success" | "error";
  error_message: string | null;
  queried_at: string | null;
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

export async function listApiVendors(target?: CodexTarget | null): Promise<ApiVendor[]> {
  await ensureVendorSchema();
  return readAppDatabase((db) => {
    const rows = target
      ? db.prepare("SELECT * FROM api_vendors WHERE provider_id = ? ORDER BY sort ASC, created_at ASC").all(target.provider)
      : db.prepare("SELECT * FROM api_vendors ORDER BY sort ASC, created_at ASC").all();
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
    const requestedSort = existing ? (normalized.sort ?? existing.sort) : (normalized.sort ?? nextVendorSort(db));
    const duplicateSort = db.prepare("SELECT id FROM api_vendors WHERE sort = ? AND id <> ?")
      .get(requestedSort, existing?.id || "") as { id: string } | undefined;
    if (duplicateSort) throw new Error(`排序值 ${requestedSort} 已被占用。`);
    const next: ApiVendor = {
      id: existing?.id || crypto.randomUUID(),
      providerId: normalized.providerId,
      name: normalized.name,
      apiKey: normalized.apiKey || existingVendor?.apiKey || "",
      apiBaseUrl: normalized.apiBaseUrl,
      sort: requestedSort,
      pricing: normalized.pricing,
      configs: normalized.configs,
      enabled: normalized.enabled !== false,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      lastEnabledAt: existing?.last_enabled_at || undefined
    };
    saved = next;
    // Gateway 直接从 SQLite 读取供应商，API Key 按用户要求以明文保存。
    const stored = next;
    db.prepare(`
      INSERT INTO api_vendors (
        id, provider_id, name, name_norm, api_key, api_base_url,
        input_price_usd, output_price_usd, sort, enabled, created_at, updated_at, last_enabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id = excluded.provider_id,
        name = excluded.name,
        name_norm = excluded.name_norm,
        api_key = excluded.api_key,
        api_base_url = excluded.api_base_url,
        input_price_usd = excluded.input_price_usd,
        output_price_usd = excluded.output_price_usd,
        sort = excluded.sort,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        last_enabled_at = excluded.last_enabled_at
    `).run(
      stored.id,
      stored.providerId,
      stored.name,
      normalizeVendorName(stored.name),
      stored.apiKey,
      stored.apiBaseUrl,
      stored.pricing?.inputPerMillionUsd ?? null,
      stored.pricing?.outputPerMillionUsd ?? null,
      stored.sort,
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
    // 余额快照与供应商生命周期一致；旧数据库尚未创建该表时忽略即可。
    try {
      db.prepare("DELETE FROM api_vendor_balance_snapshots WHERE vendor_id = ?").run(vendorId);
    } catch {
      // 余额功能首次使用前，快照表可能尚未建立。
    }
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
  const pricing = normalizePricing(input.pricing);
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
    sort: input.sort,
    pricing,
    enabled: input.enabled !== false,
    configs
  };
}

function nextVendorSort(db: SqliteDatabase) {
  const row = db.prepare("SELECT MAX(sort) AS max_sort FROM api_vendors").get() as { max_sort?: number | null } | undefined;
  return (typeof row?.max_sort === "number" ? row.max_sort : 0) + 1;
}

function normalizePricing(pricing: ApiVendorInput["pricing"]): ApiVendorInput["pricing"] {
  if (!pricing) return undefined;
  const normalize = (value: number | undefined, label: string) => {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100) {
      throw new Error(`${label}必须是非负数，且最多保留 2 位小数。`);
    }
    return Math.round(value * 100) / 100;
  };
  const result = {
    inputPerMillionUsd: normalize(pricing.inputPerMillionUsd, "输入费率"),
    outputPerMillionUsd: normalize(pricing.outputPerMillionUsd, "输出费率")
  };
  return result.inputPerMillionUsd === undefined && result.outputPerMillionUsd === undefined ? undefined : result;
}

export async function readApiVendorConfigFiles(
  request: ApiVendorConfigReadRequest,
  target?: CodexTarget | null
): Promise<ApiVendorConfigReadResult> {
  const files = await Promise.all(
    request.paths.map(async (filePath) => {
      assertAllowedConfigPath(filePath);
      // 配置预览属于辅助信息；文件不存在或 WSL 暂不可用时以空内容继续编辑，不阻断供应商表单。
      const content = await (target?.kind === "wsl"
        ? readWslConfig(target.distro!, filePath)
        : readLocalConfig(filePath)).catch(() => "");
      return { path: filePath, content };
    })
  );
  return { files };
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
      api_base_url TEXT NOT NULL,
      input_price_usd REAL,
      output_price_usd REAL,
      sort INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_enabled_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_vendors_name_norm
      ON api_vendors(name_norm);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_vendors_sort
      ON api_vendors(sort);

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
  const vendor: ApiVendor = {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    apiKey: row.api_key,
    apiBaseUrl: row.api_base_url,
    sort: row.sort,
    pricing: {
      ...(typeof row.input_price_usd === "number" ? { inputPerMillionUsd: row.input_price_usd } : {}),
      ...(typeof row.output_price_usd === "number" ? { outputPerMillionUsd: row.output_price_usd } : {})
    },
    configs: listVendorConfigs(db, row.id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEnabledAt: row.last_enabled_at || undefined
  };
  // 余额表由 vendorBalance 按需创建；兼容尚未使用余额功能的旧数据库。
  try {
    const balance = db.prepare("SELECT remaining, total, used, unit, plan_name, is_valid, status, error_message, queried_at FROM api_vendor_balance_snapshots WHERE vendor_id = ?").get(row.id) as VendorBalanceRow | undefined;
    if (balance) {
      vendor.balance = {
        remaining: balance.remaining ?? undefined,
        total: balance.total ?? undefined,
        used: balance.used ?? undefined,
        unit: balance.unit || undefined,
        planName: balance.plan_name || undefined,
        isValid: balance.is_valid === 1
      };
      vendor.balanceStatus = balance.status;
      vendor.balanceError = balance.error_message || undefined;
      vendor.balanceQueriedAt = balance.queried_at || undefined;
    }
  } catch {
    // 余额表尚未创建时忽略，首次打开供应商列表仍应正常工作。
  }
  return vendor;
}

/** Gateway 主模式下仅切换候选池状态，不写入任何 CLI 配置文件。 */
export async function setApiVendorEnabled(vendorId: string, enabled: boolean) {
  await ensureVendorSchema();
  let found = false;
  await updateAppDatabase((db) => {
    const result = db.prepare("UPDATE api_vendors SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), vendorId);
    found = result.changes > 0;
  });
  if (!found) throw new Error("供应商不存在。");
  return { vendorId, enabled };
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
