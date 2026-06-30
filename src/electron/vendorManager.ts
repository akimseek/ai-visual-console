import { safeStorage } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ApiVendor,
  ApiVendorConfigReadRequest,
  ApiVendorConfigReadResult,
  ApiVendorEnableRequest,
  ApiVendorEnableResult,
  ApiVendorInput,
  CodexTarget
} from "./types";
import { assertAllowedConfigPath } from "../shared/shellArgs";
import { attachSpawnTimeout } from "./wslProcess";

type StoredApiVendor = Omit<ApiVendor, "apiKey"> & {
  apiKey: string;
  apiKeyEncrypted?: boolean;
};

type VendorStore = {
  vendors?: StoredApiVendor[];
};

let vendorsPath = "";
let vendorBackupRoot = "";
let vendorQueue = Promise.resolve();
const CODEX_DEFAULT_MODEL_PROVIDER = "akim";

export function setVendorStorePath(filePath: string, backupRoot: string) {
  vendorsPath = filePath;
  vendorBackupRoot = backupRoot;
}

// 当系统不可用 OS 级加密（如无 keyring 的 Linux）时，API Key 只能明文落盘。
// 暴露此状态供 UI 提前告警，避免用户误以为密钥已加密。
export function isApiKeyEncryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

export async function listApiVendors(target?: CodexTarget | null): Promise<ApiVendor[]> {
  const store = await readVendorStore();
  const stored = (store.vendors || []).map(decodeVendor);
  if (!target) return sortVendors(stored);

  return sortVendors(stored.filter((vendor) => vendor.providerId === target.provider));
}

export async function saveApiVendor(input: ApiVendorInput): Promise<ApiVendor> {
  const normalized = normalizeVendorInput(input);
  const now = new Date().toISOString();
  let saved: ApiVendor | null = null;

  await updateVendorStore((store) => {
    const vendors = store.vendors || [];
    const existing = normalized.id ? vendors.find((vendor) => vendor.id === normalized.id) : null;
    const duplicate = vendors
      .map(decodeVendor)
      .find((vendor) => vendor.id !== existing?.id && sameVendorName(vendor.name, normalized.name));
    if (duplicate) throw new Error(`供应商名称已存在：${normalized.name}`);
    const next: ApiVendor = {
      id: existing?.id || crypto.randomUUID(),
      providerId: normalized.providerId,
      name: normalized.name,
      apiKey: normalized.apiKey,
      apiBaseUrl: normalized.apiBaseUrl,
      writeCommonConfig: normalized.writeCommonConfig,
      configs: normalized.configs,
      enabled: existing?.enabled,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastEnabledAt: existing?.lastEnabledAt
    };
    saved = next;
    return {
      vendors: [
        encodeVendor(next),
        ...vendors.filter((vendor) => vendor.id !== next.id)
      ]
    };
  });

  return saved!;
}

export async function deleteApiVendor(vendorId: string) {
  await updateVendorStore((store) => ({
    vendors: (store.vendors || []).filter((vendor) => vendor.id !== vendorId)
  }));
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

  await updateVendorStore((store) => ({
    vendors: (store.vendors || []).map((item) => ({
      ...item,
      enabled: item.id === vendor.id,
      lastEnabledAt: item.id === vendor.id ? enabledAt : item.lastEnabledAt,
      updatedAt: item.id === vendor.id ? enabledAt : item.updatedAt
    }))
  }));

  return { vendorId: vendor.id, written, backupRoot };
}

function normalizeVendorInput(input: ApiVendorInput): ApiVendorInput {
  const name = input.name.trim();
  const apiKey = input.apiKey.trim();
  const apiBaseUrl = input.apiBaseUrl.trim();
  if (!name) throw new Error("供应商名称不能为空。");
  if (!apiKey) throw new Error("API Key 不能为空。");
  if (!apiBaseUrl) throw new Error("API 请求地址不能为空。");
  const configs = input.configs.map((config) => ({
    id: config.id?.trim() || crypto.randomUUID(),
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
  } catch {
    return { ...vendor, apiKey: "" };
  }
}

function sortVendors(vendors: ApiVendor[]) {
  return [...vendors].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function sameVendorName(left: string, right: string) {
  return normalizeVendorName(left) === normalizeVendorName(right);
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

function runWslShell(distro: string, script: string) {
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  const shellScript = `printf %s ${shellQuote(encodedScript)} | base64 -d | bash`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(getWslExe(), ["-d", distro, "--", "bash", "-lc", shellScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const clearTimer = attachSpawnTimeout(child, reject, `WSL 写入（${distro}）`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimer();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimer();
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `WSL 写入失败，退出码 ${code}`));
    });
    child.stdin.end();
  });
}

function getWslExe() {
  return process.platform === "win32" ? "wsl.exe" : "wsl";
}

async function readVendorStore(): Promise<VendorStore> {
  if (!vendorsPath) return {};
  try {
    return JSON.parse(await fs.readFile(vendorsPath, "utf8")) as VendorStore;
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    return {};
  }
}

async function updateVendorStore(updater: (store: VendorStore) => VendorStore) {
  if (!vendorsPath) return;
  vendorQueue = vendorQueue.catch(() => undefined).then(async () => {
    const store = updater(await readVendorStore());
    await fs.mkdir(path.dirname(vendorsPath), { recursive: true });
    const tempPath = `${vendorsPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, vendorsPath);
  });
  await vendorQueue;
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 100) || "vendor";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
