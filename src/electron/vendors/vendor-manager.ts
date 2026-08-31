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
  VendorModel,
  VendorModelQueryConfig,
  VendorBalanceQueryConfig,
  VendorQueryAuthMode
} from "../types";
import { assertAllowedConfigPath } from "../../shared/shell-args";
import { runWslShell, shellQuote } from "../terminal/wsl-process";
import {
  readAppDatabase,
  setSessionDatabasePath,
  type SqliteDatabase,
  updateAppDatabase
} from "../core/app-database";

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

type VendorQueryConfigRow = {
  vendor_id: string;
  model_query_json: string | null;
  balance_query_json: string | null;
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
  return vendors.map((vendor) => ({
    ...vendor,
    apiKey: "",
    modelQuery: vendor.modelQuery ? { ...vendor.modelQuery, headers: undefined } : undefined,
    balanceQuery: vendor.balanceQuery
      ? { ...vendor.balanceQuery, accessToken: undefined, headers: undefined }
      : undefined
  }));
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
      modelQuery: normalized.modelQuery,
      balanceQuery: normalized.balanceQuery,
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
    db.prepare(`
      INSERT INTO api_vendor_query_configs (vendor_id, model_query_json, balance_query_json)
      VALUES (?, ?, ?)
      ON CONFLICT(vendor_id) DO UPDATE SET
        model_query_json = excluded.model_query_json,
        balance_query_json = excluded.balance_query_json
    `).run(
      stored.id,
      stored.modelQuery ? JSON.stringify(stored.modelQuery) : null,
      stored.balanceQuery ? JSON.stringify(stored.balanceQuery) : null
    );
  });

  return saved!;
}

export async function deleteApiVendor(vendorId: string) {
  await ensureVendorSchema();
  await updateAppDatabase((db) => {
    db.prepare("DELETE FROM api_vendor_query_configs WHERE vendor_id = ?").run(vendorId);
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
    modelQuery: normalizeModelQueryConfig(input.modelQuery),
    balanceQuery: normalizeBalanceQueryConfig(input.balanceQuery),
    enabled: input.enabled !== false,
    configs
  };
}

const QUERY_CONFIG_MAX_JSON_BYTES = 32 * 1024;
const QUERY_HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

function normalizeModelQueryConfig(config: ApiVendorInput["modelQuery"]): VendorModelQueryConfig | undefined {
  if (!config) return undefined;
  const normalized: VendorModelQueryConfig = {
    endpoint: normalizeQueryText(config.endpoint, 2000),
    authMode: normalizeAuthMode(config.authMode),
    authHeaderName: normalizeHeaderName(config.authHeaderName),
    authQueryName: normalizeQueryText(config.authQueryName, 100),
    headers: normalizeHeaders(config.headers)
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > QUERY_CONFIG_MAX_JSON_BYTES) throw new Error("供应商查询配置过大。");
  return hasQueryValues(normalized) ? normalized : undefined;
}

function normalizeBalanceQueryConfig(config: ApiVendorInput["balanceQuery"]): VendorBalanceQueryConfig | undefined {
  if (!config) return undefined;
  const normalized: VendorBalanceQueryConfig = {
    template: config.template || "auto",
    baseUrl: normalizeQueryText(config.baseUrl, 2000),
    endpoint: normalizeQueryText(config.endpoint, 2000),
    method: config.method === "POST" ? "POST" : config.method === "GET" ? "GET" : undefined,
    authMode: normalizeAuthMode(config.authMode),
    authHeaderName: normalizeHeaderName(config.authHeaderName),
    authQueryName: normalizeQueryText(config.authQueryName, 100),
    headers: normalizeHeaders(config.headers),
    accessToken: normalizeQueryText(config.accessToken, 4000),
    userId: normalizeQueryText(config.userId, 200),
    remainingPath: normalizeQueryText(config.remainingPath, 300),
    totalPath: normalizeQueryText(config.totalPath, 300),
    usedPath: normalizeQueryText(config.usedPath, 300),
    unitPath: normalizeQueryText(config.unitPath, 300),
    planPath: normalizeQueryText(config.planPath, 300),
    validPath: normalizeQueryText(config.validPath, 300),
    statusPath: normalizeQueryText(config.statusPath, 300),
    invalidMessagePath: normalizeQueryText(config.invalidMessagePath, 300),
    multiplier: typeof config.multiplier === "number" && Number.isFinite(config.multiplier) ? config.multiplier : undefined
  };
  if (!Object.values({ auto: "auto", generic: "generic", "new-api": "new-api", custom: "custom" }).includes(normalized.template || "auto")) {
    throw new Error("余额查询模板无效。");
  }
  if (normalized.multiplier !== undefined && (normalized.multiplier <= 0 || normalized.multiplier > 1_000_000)) {
    throw new Error("余额换算倍率必须大于 0 且不超过 1000000。");
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > QUERY_CONFIG_MAX_JSON_BYTES) throw new Error("供应商查询配置过大。");
  return normalized.template === "auto" && Object.keys(normalized).length === 1 ? undefined : normalized;
}

function normalizeQueryText(value: string | undefined, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, maxLength);
}

function normalizeHeaderName(value: string | undefined) {
  const normalized = normalizeQueryText(value, 100);
  if (!normalized) return undefined;
  if (!QUERY_HEADER_NAME_PATTERN.test(normalized)) throw new Error("自定义认证 Header 名称无效。");
  return normalized;
}

function normalizeAuthMode(value: VendorQueryAuthMode | undefined): VendorQueryAuthMode | undefined {
  if (value === undefined) return undefined;
  if (!["bearer", "x-api-key", "x-goog-api-key", "api-key", "query", "none"].includes(value)) {
    throw new Error("查询认证方式无效。");
  }
  return value;
}

function normalizeHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).slice(0, 32).map(([name, value]) => {
    if (!QUERY_HEADER_NAME_PATTERN.test(name) || typeof value !== "string" || value.length > 4000 || /[\r\n]/.test(value)) throw new Error("自定义请求头无效。");
    return [name, value] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function hasQueryValues(value: Record<string, unknown>) {
  return Object.values(value).some((item) => item !== undefined && item !== null && item !== "");
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

    CREATE TABLE IF NOT EXISTS api_vendor_query_configs (
      vendor_id TEXT PRIMARY KEY,
      model_query_json TEXT,
      balance_query_json TEXT,
      FOREIGN KEY (vendor_id) REFERENCES api_vendors(id) ON DELETE CASCADE
    );
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
    ...readVendorQueryConfigs(db, row.id),
    configs: listVendorConfigs(db, row.id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEnabledAt: row.last_enabled_at || undefined
  };
  // 余额表由 Gateway 余额模块按需创建；兼容尚未使用余额功能的旧数据库。
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

function readVendorQueryConfigs(db: SqliteDatabase, vendorId: string): Pick<ApiVendor, "modelQuery" | "balanceQuery"> {
  try {
    const row = db.prepare("SELECT model_query_json, balance_query_json FROM api_vendor_query_configs WHERE vendor_id = ?").get(vendorId) as VendorQueryConfigRow | undefined;
    if (!row) return {};
    return {
      modelQuery: parseQueryConfig(row.model_query_json) as VendorModelQueryConfig | undefined,
      balanceQuery: parseQueryConfig(row.balance_query_json) as VendorBalanceQueryConfig | undefined
    };
  } catch {
    // 查询配置表不存在时返回空配置，便于数据库初始化过程中的只读调用继续工作。
    return {};
  }
}

function parseQueryConfig(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
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

const MODEL_LIST_TIMEOUT_MS = 15_000;
const MODEL_LIST_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_LIST_MAX_COUNT = 500;
const MODEL_COMPAT_SUFFIXES = [
  "/api/claudecode", "/api/anthropic", "/apps/anthropic", "/api/coding",
  "/claudecode", "/anthropic", "/step_plan", "/coding", "/claude"
];

export async function listVendorModels(vendorId: string): Promise<VendorModel[]> {
  const vendors = await listApiVendors();
  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) throw new Error("供应商不存在。");
  if (!vendor.apiBaseUrl) throw new Error("供应商未配置 API 地址。");

  let baseUrl: URL;
  try {
    baseUrl = new URL(vendor.apiBaseUrl);
  } catch {
    throw new Error("供应商 API 地址格式无效。");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("供应商 API 地址必须使用 HTTP 或 HTTPS。");
  }
  const modelUrls = vendor.modelQuery?.endpoint
    ? [resolveConfiguredEndpoint(vendor.modelQuery.endpoint, baseUrl)]
    : buildModelEndpointCandidates(baseUrl, vendor.providerId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    let lastError = "获取模型列表失败。";
    for (const modelsUrl of modelUrls) {
      const authModes = vendor.modelQuery?.authMode
        ? [vendor.modelQuery.authMode]
        : modelAuthModes(vendor.providerId);
      for (const authMode of authModes) {
        const response = await fetch(applyModelAuthQuery(modelsUrl, authMode, vendor.apiKey, vendor.modelQuery), {
          headers: buildModelHeaders(authMode, vendor.apiKey, vendor.modelQuery), signal: controller.signal
        });
        if (!response.ok) {
          lastError = `获取模型列表失败 (${response.status})`;
          // 只有认证失败才继续尝试另一种认证方式；路径/服务端错误直接进入下一个地址，
          // 避免对同一故障端点重复发送多次请求。
          if (response.status !== 401 && response.status !== 403) break;
          continue;
        }
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MODEL_LIST_MAX_BYTES) throw new Error("模型列表响应过大。");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          lastError = "模型列表响应不是有效 JSON。";
          continue;
        }
        const models = extractModelRows(body)
          .map((item) => toVendorModel(item, vendor.providerId))
          .filter((model): model is VendorModel => Boolean(model));
        const uniqueModels = [...new Map(models.map((model) => [model.id.toLowerCase(), model])).values()]
          .sort((left, right) => left.id.localeCompare(right.id));
        if (uniqueModels.length > 0) return uniqueModels.slice(0, MODEL_LIST_MAX_COUNT);
        lastError = "模型列表响应中没有可识别的模型。";
      }
    }
    throw new Error(lastError);
  } finally {
    clearTimeout(timer);
  }
}

function resolveConfiguredEndpoint(endpoint: string, baseUrl: URL) {
  try {
    const resolved = new URL(endpoint, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") throw new Error("protocol");
    return resolved.toString();
  } catch {
    throw new Error("模型查询地址格式无效。");
  }
}

function buildModelEndpointCandidates(baseUrl: URL, providerId: ApiVendor["providerId"]) {
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const candidates: string[] = [];
  const add = (path: string) => {
    const url = new URL(baseUrl.toString());
    url.pathname = path.replace(/\/{2,}/g, "/").replace(/^(?!\/)/, "/");
    const value = url.toString();
    if (!candidates.includes(value)) candidates.push(value);
  };
  if (/\/models$/i.test(basePath)) add(basePath);
  else if (providerId === "gemini") {
    if (/\/v1beta$/i.test(basePath)) add(`${basePath}/models`);
    else if (/\/v1$/i.test(basePath)) add(`${basePath.slice(0, -3)}/v1beta/models`);
    else add(`${basePath}/v1beta/models`);
    add(`${basePath}/v1/models`);
    add(`${basePath}/models`);
  } else if (/\/v\d+(?:\.\d+)?$/i.test(basePath)) {
    add(`${basePath}/models`);
    if (!/\/v1$/i.test(basePath)) add(`${basePath}/v1/models`);
  } else {
    add(`${basePath}/v1/models`);
    add(`${basePath}/models`);
  }
  for (const suffix of MODEL_COMPAT_SUFFIXES) {
    if (!basePath.endsWith(suffix)) continue;
    const root = basePath.slice(0, -suffix.length).replace(/\/+$/, "");
    if (root) { add(`${root}/v1/models`); add(`${root}/models`); }
    break;
  }
  if (/\/(?:responses|chat\/completions)$/i.test(basePath)) {
    const root = basePath.replace(/\/(?:responses|chat\/completions)$/i, "");
    add(`${root}/v1/models`); add(`${root}/models`);
  }
  return candidates;
}

function modelAuthModes(providerId: ApiVendor["providerId"]): Array<"bearer" | "x-api-key" | "x-goog-api-key" | "api-key" | "query"> {
  if (providerId === "gemini") return ["x-goog-api-key", "query", "bearer", "api-key"];
  if (providerId === "claude") return ["x-api-key", "bearer", "api-key"];
  return ["bearer", "api-key", "x-api-key"];
}

function buildModelHeaders(
  mode: ReturnType<typeof modelAuthModes>[number] | VendorQueryAuthMode,
  apiKey: string,
  config?: VendorModelQueryConfig
) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config?.headers) Object.assign(headers, config.headers);
  if (mode === "bearer") headers[config?.authHeaderName || "authorization"] = `Bearer ${apiKey}`;
  else if (mode === "x-api-key") headers[config?.authHeaderName || "x-api-key"] = apiKey;
  else if (mode === "x-goog-api-key") headers[config?.authHeaderName || "x-goog-api-key"] = apiKey;
  else if (mode === "api-key") headers[config?.authHeaderName || "api-key"] = apiKey;
  return headers;
}

function applyModelAuthQuery(url: string, mode: ReturnType<typeof modelAuthModes>[number] | VendorQueryAuthMode, apiKey: string, config?: VendorModelQueryConfig) {
  if (mode !== "query" || !apiKey) return url;
  const parsed = new URL(url);
  const queryName = config?.authQueryName || "key";
  if (!parsed.searchParams.has(queryName)) parsed.searchParams.set(queryName, apiKey);
  return parsed.toString();
}

function extractModelRows(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  return ["data", "models", "items", "results", "model_list"]
    .flatMap((key) => Array.isArray(body[key]) ? body[key].filter(isRecord) : []);
}

function toVendorModel(item: Record<string, unknown>, providerId: ApiVendor["providerId"]): VendorModel | undefined {
  const rawId = [item.id, item.model, item.name, item.slug].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!rawId) return undefined;
  const id = providerId === "gemini" ? rawId.trim().replace(/^models\//i, "") : rawId.trim();
  if (!id || id.length > 200 || /[\s\u0000-\u001f]/.test(id)) return undefined;
  return {
    id,
    object: typeof item.object === "string" ? item.object : undefined,
    ownedBy: typeof item.owned_by === "string" ? item.owned_by : typeof item.ownedBy === "string" ? item.ownedBy : undefined,
    created: typeof item.created === "number" ? item.created : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    pricingMultiplier: typeof item.pricingMultiplier === "number" ? item.pricingMultiplier : undefined,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
