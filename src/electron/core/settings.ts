import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { CodexTarget, WorkspacePreset, WorkspacePresetInput } from "../types";
import {
  deleteWorkspacePresetRecord,
  hasAppDatabase,
  listWorkspacePresetRecords,
  saveWorkspacePresetRecord
} from "./app-database";

type AppSettings = {
  wslCodexHomes?: Record<string, string>;
  gatewayPort?: number;
  gatewayEnabled?: boolean;
  gatewayExternalApiEnabled?: boolean;
  gatewayExternalApiTokenHash?: string;
  gatewayFailureThreshold?: number;
  gatewayCircuitFailureThreshold?: number;
  gatewayCircuitDurationSeconds?: number;
  cachedTargets?: CodexTarget[];
  workspacePresets?: WorkspacePreset[];
};

let settingsPath = "";
let settingsQueue = Promise.resolve();
let structuredSettingsMigration: Promise<void> | null = null;
// settings.json 的内存缓存：主进程是唯一写入方，读盘+解析只做一次；
// updateSettings 写透更新缓存，setSettingsPath 切换路径时丢弃。
let settingsCache: AppSettings | null = null;

export function setSettingsPath(filePath: string) {
  settingsPath = filePath;
  settingsCache = null;
  structuredSettingsMigration = null;
}

export async function getGatewayPort() {
  const settings = await readSettings();
  return normalizeGatewayPort(settings.gatewayPort);
}

export async function getGatewayEnabled() {
  const settings = await readSettings();
  return settings.gatewayEnabled !== false;
}

export async function setGatewayEnabled(enabled: boolean) {
  await updateSettings((settings) => ({ ...settings, gatewayEnabled: enabled }));
  return enabled;
}

export async function getGatewayExternalApiStatus() {
  const settings = await readSettings();
  return {
    enabled: settings.gatewayExternalApiEnabled === true,
    tokenConfigured: Boolean(settings.gatewayExternalApiTokenHash)
  };
}

export async function getGatewayExternalApiEnabled() {
  const settings = await readSettings();
  return settings.gatewayExternalApiEnabled === true;
}

export async function setGatewayExternalApiEnabled(enabled: boolean) {
  await updateSettings((settings) => ({ ...settings, gatewayExternalApiEnabled: enabled }));
  return enabled;
}

export async function getGatewayExternalApiTokenHash() {
  const settings = await readSettings();
  return settings.gatewayExternalApiTokenHash || "";
}

export async function rotateGatewayExternalApiToken() {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await updateSettings((settings) => ({ ...settings, gatewayExternalApiTokenHash: tokenHash }));
  return token;
}

export async function setGatewayPort(port: number) {
  const normalized = normalizeGatewayPort(port);
  await updateSettings((settings) => ({ ...settings, gatewayPort: normalized }));
  return normalized;
}

export async function getGatewayFailureThreshold() {
  const settings = await readSettings();
  return normalizeGatewayFailureThreshold(settings.gatewayFailureThreshold);
}

export async function setGatewayFailureThreshold(threshold: number) {
  const normalized = normalizeGatewayFailureThreshold(threshold);
  await updateSettings((settings) => ({ ...settings, gatewayFailureThreshold: normalized }));
  return normalized;
}

export async function getGatewayCircuitFailureThreshold() {
  const settings = await readSettings();
  return normalizeGatewayCircuitFailureThreshold(settings.gatewayCircuitFailureThreshold);
}

export async function setGatewayCircuitFailureThreshold(threshold: number) {
  const normalized = normalizeGatewayCircuitFailureThreshold(threshold);
  await updateSettings((settings) => ({ ...settings, gatewayCircuitFailureThreshold: normalized }));
  return normalized;
}

export async function getGatewayCircuitDurationSeconds() {
  const settings = await readSettings();
  return normalizeGatewayCircuitDurationSeconds(settings.gatewayCircuitDurationSeconds);
}

export async function setGatewayCircuitDurationSeconds(seconds: number) {
  const normalized = normalizeGatewayCircuitDurationSeconds(seconds);
  await updateSettings((settings) => ({ ...settings, gatewayCircuitDurationSeconds: normalized }));
  return normalized;
}

function normalizeGatewayPort(port: unknown) {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) return 0;
  return port;
}

// 默认值 1 保持现有行为：单供应商首次失败后尝试下一个候选供应商。
function normalizeGatewayFailureThreshold(threshold: unknown) {
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1 || threshold > 10) return 1;
  return threshold;
}

function normalizeGatewayCircuitFailureThreshold(threshold: unknown) {
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1 || threshold > 20) return 3;
  return threshold;
}

function normalizeGatewayCircuitDurationSeconds(seconds: unknown) {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 10 || seconds > 86_400) return 60;
  return seconds;
}

export async function getWslCodexHomeOverride(distro: string) {
  const settings = await readSettings();
  return settings.wslCodexHomes?.[distro] || "";
}

export async function setWslCodexHomeOverride(distro: string, codexHome: string) {
  await updateSettings((settings) => ({
    ...settings,
    wslCodexHomes: {
      ...(settings.wslCodexHomes || {}),
      [distro]: codexHome.trim()
    }
  }));
}

export async function clearWslCodexHomeOverride(distro: string) {
  await updateSettings((settings) => {
    const nextHomes = { ...(settings.wslCodexHomes || {}) };
    delete nextHomes[distro];
    return {
      ...settings,
      wslCodexHomes: nextHomes
    };
  });
}

export async function getCachedTargets() {
  const settings = await readSettings();
  return settings.cachedTargets || [];
}

export async function setCachedTargets(targets: CodexTarget[]) {
  await updateSettings((settings) => ({
    ...settings,
    cachedTargets: mergeCachedTargetsByProvider(settings.cachedTargets || [], targets)
  }));
}

export async function listWorkspacePresets() {
  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    return listWorkspacePresetRecords();
  }
  const settings = await readSettings();
  return sortWorkspacePresets(settings.workspacePresets || []);
}

export async function saveWorkspacePreset(input: WorkspacePresetInput) {
  const normalized = normalizeWorkspacePresetInput(input);
  const now = new Date().toISOString();
  const preset: WorkspacePreset = {
    id: crypto.randomUUID(),
    ...normalized,
    updatedAt: now
  };

  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    const existing = await listWorkspacePresetRecords();
    const duplicate = existing.find((item) => item.id !== preset.id && item.cwd === preset.cwd && item.targetKind === preset.targetKind);
    if (duplicate) await deleteWorkspacePresetRecord(duplicate.id);
    await saveWorkspacePresetRecord(preset);
    return preset;
  }

  await updateSettings((settings) => {
    const existing = settings.workspacePresets || [];
    const filtered = existing.filter((item) => item.cwd !== preset.cwd || item.targetKind !== preset.targetKind);
    return {
      ...settings,
      workspacePresets: sortWorkspacePresets([preset, ...filtered]).slice(0, 20)
    };
  });

  return preset;
}

export async function deleteWorkspacePreset(presetId: string) {
  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    await deleteWorkspacePresetRecord(presetId);
    return { deleted: true };
  }
  await updateSettings((settings) => ({
    ...settings,
    workspacePresets: (settings.workspacePresets || []).filter((preset) => preset.id !== presetId)
  }));
  return { deleted: true };
}

function normalizeWorkspacePresetInput(input: WorkspacePresetInput) {
  const cwd = input.cwd.trim();
  if (!cwd) throw new Error("工作目录不能为空。");
  const name = input.name.trim() || cwd;
  return {
    name: name.slice(0, 60),
    cwd,
    targetKind: input.targetKind,
    prompt: input.prompt?.trim().slice(0, 4000) || undefined,
    cliArgs: input.cliArgs?.trim().slice(0, 400) || undefined
  };
}

function sortWorkspacePresets(presets: WorkspacePreset[]) {
  return [...presets].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function ensureStructuredSettingsMigrated() {
  if (!structuredSettingsMigration) structuredSettingsMigration = migrateStructuredSettings();
  await structuredSettingsMigration;
}

async function migrateStructuredSettings() {
  const settings = await readSettings();
  const legacyPresets = settings.workspacePresets || [];
  const currentPresets = await listWorkspacePresetRecords();

  if (currentPresets.length === 0) {
    for (const preset of legacyPresets) await saveWorkspacePresetRecord(preset);
  }
  if (legacyPresets.length === 0) return;

  await updateSettings((current) => ({
    ...current,
    workspacePresets: undefined
  }));
}

function mergeCachedTargetsByProvider(current: CodexTarget[], next: CodexTarget[]) {
  if (next.length === 0) return current;
  const providers = new Set(next.map((target) => target.provider || "codex"));
  return [
    ...current.filter((target) => !providers.has(target.provider || "codex")),
    ...next
  ];
}

async function readSettings(): Promise<AppSettings> {
  if (!settingsPath) return {};
  if (settingsCache) return settingsCache;
  try {
    const value = JSON.parse(await fs.readFile(settingsPath, "utf8")) as AppSettings;
    settingsCache = value;
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      settingsCache = {};
      return settingsCache;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[settings-read-failed] ${message}`, error);
    await backupBrokenSettings(error);
    // 损坏配置按空配置降级，并缓存本次结果，避免网关热路径重复读盘、解析和备份。
    settingsCache = {};
    return settingsCache;
  }
}

async function updateSettings(updater: (settings: AppSettings) => AppSettings) {
  if (!settingsPath) return;
  settingsQueue = settingsQueue.catch(() => undefined).then(async () => {
    const settings = updater(await readSettings());
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(settings, null, 2), "utf8");
    await fs.rename(tempPath, settingsPath);
    settingsCache = settings;
  });
  await settingsQueue;
}

async function backupBrokenSettings(error: unknown) {
  if (!settingsPath || (error as NodeJS.ErrnoException)?.code === "ENOENT") return;
  const backupPath = `${settingsPath}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.copyFile(settingsPath, backupPath);
  } catch {
    // 备份失败时仍允许应用回退到默认设置。
  }
}
