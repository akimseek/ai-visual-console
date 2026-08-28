import fs from "node:fs/promises";
import path from "node:path";
import type { CodexTarget, CompressionPrompt, CompressionPromptInput, WorkspacePreset, WorkspacePresetInput } from "../types";
import {
  deleteCompressionPromptRecord,
  deleteWorkspacePresetRecord,
  hasAppDatabase,
  listCompressionPromptRecords,
  listWorkspacePresetRecords,
  saveCompressionPromptRecord,
  saveWorkspacePresetRecord
} from "./app-database";

type AppSettings = {
  wslCodexHomes?: Record<string, string>;
  gatewayPort?: number;
  gatewayFailureThreshold?: number;
  gatewayCircuitFailureThreshold?: number;
  gatewayCircuitDurationSeconds?: number;
  cachedTargets?: CodexTarget[];
  workspacePresets?: WorkspacePreset[];
  compressionPrompts?: CompressionPrompt[];
};

const DEFAULT_COMPRESSION_PROMPT_CONTENT = `请生成“可恢复工作状态摘要”，用于新 Session 恢复上下文。

保留：

1. 当前任务目标
2. 已完成内容
3. 关键架构决策
4. 修改过的文件
5. 未解决问题
6. 下一步计划
7. 关键错误日志

要求：

- 使用 markdown
- 使用 checklist
- 不要解释过程
- 不要自然语言总结
- 保留精确路径
- 保留关键命令、配置、SQL、错误日志
- 控制在 1200 token
- 输出必须适合 AI 继续接手开发`;

let settingsPath = "";
let settingsQueue = Promise.resolve();
let structuredSettingsMigration: Promise<void> | null = null;

export function setSettingsPath(filePath: string) {
  settingsPath = filePath;
  structuredSettingsMigration = null;
}

export async function getGatewayPort() {
  const settings = await readSettings();
  return normalizeGatewayPort(settings.gatewayPort);
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

export async function listCompressionPrompts() {
  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    const prompts = await listCompressionPromptRecords();
    if (prompts.length > 0) return sortCompressionPrompts(prompts);
    const initial = [createDefaultCompressionPrompt()];
    await saveCompressionPromptRecord(initial[0]);
    return initial;
  }
  const settings = await readSettings();
  if (!settings.compressionPrompts) {
    const initial = [createDefaultCompressionPrompt()];
    await updateSettings((current) => ({ ...current, compressionPrompts: initial }));
    return initial;
  }
  const migrated = migrateCompressionPrompts(settings.compressionPrompts);
  if (JSON.stringify(migrated) !== JSON.stringify(settings.compressionPrompts)) {
    await updateSettings((current) => ({ ...current, compressionPrompts: migrated }));
  }
  return sortCompressionPrompts(migrated);
}

export async function saveCompressionPrompt(input: CompressionPromptInput) {
  const normalized = normalizeCompressionPromptInput(input);
  const now = new Date().toISOString();
  let saved: CompressionPrompt | null = null;

  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    const existing = (await listCompressionPromptRecords()).find((item) => item.id === normalized.id);
    saved = {
      id: existing?.id || normalized.id || crypto.randomUUID(),
      name: normalized.name,
      content: normalized.content,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await saveCompressionPromptRecord(saved);
    return saved;
  }

  await updateSettings((settings) => {
    const existing = settings.compressionPrompts || [];
    const current = normalized.id ? existing.find((item) => item.id === normalized.id) : null;
    saved = {
      id: current?.id || crypto.randomUUID(),
      name: normalized.name,
      content: normalized.content,
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    return {
      ...settings,
      compressionPrompts: sortCompressionPrompts([
        saved,
        ...existing.filter((item) => item.id !== saved!.id)
      ]).slice(0, 50)
    };
  });

  return saved!;
}

export async function deleteCompressionPrompt(promptId: string) {
  if (hasAppDatabase()) {
    await ensureStructuredSettingsMigrated();
    await deleteCompressionPromptRecord(promptId);
    return { deleted: true };
  }
  await updateSettings((settings) => ({
    ...settings,
    compressionPrompts: (settings.compressionPrompts || []).filter((prompt) => prompt.id !== promptId)
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

function createDefaultCompressionPrompt(): CompressionPrompt {
  const now = new Date().toISOString();
  return {
    id: "default-recoverable-work-summary",
    name: "可恢复工作状态摘要",
    content: DEFAULT_COMPRESSION_PROMPT_CONTENT,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeCompressionPromptInput(input: CompressionPromptInput) {
  const name = input.name.trim();
  const content = input.content.trim();
  if (!name) throw new Error("提示名称不能为空。");
  if (!content) throw new Error("提示内容不能为空。");
  return {
    id: input.id?.trim() || undefined,
    name: name.slice(0, 80),
    content: content.slice(0, 20000)
  };
}

function sortCompressionPrompts(prompts: CompressionPrompt[]) {
  return [...prompts].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function ensureStructuredSettingsMigrated() {
  if (!structuredSettingsMigration) structuredSettingsMigration = migrateStructuredSettings();
  await structuredSettingsMigration;
}

async function migrateStructuredSettings() {
  const settings = await readSettings();
  const legacyPresets = settings.workspacePresets || [];
  const legacyPrompts = settings.compressionPrompts || [];
  const currentPresets = await listWorkspacePresetRecords();
  const currentPrompts = await listCompressionPromptRecords();

  if (currentPresets.length === 0) {
    for (const preset of legacyPresets) await saveWorkspacePresetRecord(preset);
  }
  if (currentPrompts.length === 0) {
    for (const prompt of legacyPrompts) await saveCompressionPromptRecord(prompt);
  }
  if (legacyPresets.length === 0 && legacyPrompts.length === 0) return;

  await updateSettings((current) => ({
    ...current,
    workspacePresets: undefined,
    compressionPrompts: undefined
  }));
}

function migrateCompressionPrompts(prompts: CompressionPrompt[]) {
  return prompts.map((prompt) => {
    if (prompt.id !== "default-recoverable-work-summary") return prompt;
    const content = removeSessionInfoBlock(prompt.content);
    return content === prompt.content ? prompt : { ...prompt, content };
  });
}

function removeSessionInfoBlock(content: string) {
  return content.replace(
    /\n+当前会话信息：\n- 会话编号：\{\{session_id\}\}\n- 标题：\{\{session_title\}\}\n- 工作目录：\{\{session_cwd\}\}\n- 模型：\{\{session_model\}\}\n- Token：\{\{session_token\}\}\n- 上下文：\{\{session_context\}\}\n+/,
    "\n\n"
  );
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
  try {
    return JSON.parse(await fs.readFile(settingsPath, "utf8")) as AppSettings;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[settings-read-failed] ${message}`, error);
    await backupBrokenSettings(error);
    return {};
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
