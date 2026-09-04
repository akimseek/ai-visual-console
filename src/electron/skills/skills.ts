import fs from "node:fs/promises";
import path from "node:path";
import { getCodexHome } from "../providers/codex/codex-store";
import { pathExists } from "../core/fs-utils";
import { runWslShell, wslPathExists, wslReadFile, wslWriteFile } from "../core/wsl";
import { shellQuote } from "../../shared/wsl-paths";
import type { CodexTarget, InstalledSkill } from "../types";

const MAX_SKILL_MD_BYTES = 2 * 1024 * 1024;
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules"]);

export type SkillImportPlan = {
  sourcePath: string;
  destinationPath: string;
  skillName: string;
  description: string;
  kind: "file" | "directory";
  exists: boolean;
  target: CodexTarget;
};

export async function planSkillImport(sourcePath: string, target: CodexTarget): Promise<SkillImportPlan> {
  const codexHome = requireTargetCodexHome(target);
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat) throw new Error("选择的路径不存在。");

  const kind = sourceStat.isDirectory() ? "directory" : sourceStat.isFile() ? "file" : null;
  if (!kind) throw new Error("只能导入 Markdown 文件或 skill 目录。");

  const skillFilePath = kind === "directory" ? path.join(sourcePath, "SKILL.md") : sourcePath;
  if (kind === "file" && path.extname(sourcePath).toLowerCase() !== ".md") {
    throw new Error("请选择 Markdown 文件。");
  }

  const metadata = await readSkillMetadata(skillFilePath);
  const destinationPath =
    target.kind === "wsl"
      ? path.posix.join(codexHome, "skills", metadata.name)
      : path.join(codexHome, "skills", metadata.name);

  return {
    sourcePath,
    destinationPath,
    skillName: metadata.name,
    description: metadata.description,
    kind,
    exists: target.kind === "wsl" ? await wslPathExists(target.distro!, destinationPath) : await pathExists(destinationPath),
    target
  };
}

export async function importSkill(plan: SkillImportPlan, overwrite: boolean) {
  if (plan.exists && !overwrite) throw new Error(`skill 已存在：${plan.skillName}`);

  if (plan.target.kind === "wsl") {
    await importWslSkill(plan);
    return {
      skillName: plan.skillName,
      destinationPath: plan.destinationPath
    };
  }

  const parentPath = path.dirname(plan.destinationPath);
  const tempPath = path.join(parentPath, `.import-${process.pid}-${Date.now()}`);
  const backupPath = path.join(parentPath, `.backup-${plan.skillName}-${process.pid}-${Date.now()}`);
  await fs.mkdir(parentPath, { recursive: true });
  if (plan.kind === "directory") {
    await copySkillDirectory(plan.sourcePath, tempPath);
  } else {
    await fs.mkdir(tempPath, { recursive: true });
    await fs.copyFile(plan.sourcePath, path.join(tempPath, "SKILL.md"));
  }

  try {
    if (plan.exists) {
      await fs.rename(plan.destinationPath, backupPath);
    }
    await fs.rename(tempPath, plan.destinationPath);
    if (plan.exists) {
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
    if (plan.exists && !(await pathExists(plan.destinationPath)) && (await pathExists(backupPath))) {
      await fs.rename(backupPath, plan.destinationPath).catch(() => undefined);
    }
    throw error;
  }

  return {
    skillName: plan.skillName,
    destinationPath: plan.destinationPath
  };
}

export async function listSkills(target: CodexTarget): Promise<InstalledSkill[]> {
  const codexHome = requireTargetCodexHome(target);
  const skillsPath = target.kind === "wsl" ? path.posix.join(codexHome, "skills") : path.join(codexHome, "skills");
  const names = target.kind === "wsl" ? await listWslSkillNames(target, skillsPath) : await listLocalSkillNames(skillsPath);
  const skills = await Promise.all(names.map((name) => readInstalledSkill(target, skillsPath, name)));
  return skills
    .filter((skill): skill is InstalledSkill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listTrashSkills(target: CodexTarget): Promise<InstalledSkill[]> {
  const codexHome = requireTargetCodexHome(target);
  const trashPath =
    target.kind === "wsl"
      ? path.posix.join(codexHome, ".visual-console-trash", "skills")
      : path.join(codexHome, ".visual-console-trash", "skills");
  const names = target.kind === "wsl" ? await listWslSkillNames(target, trashPath) : await listLocalSkillNames(trashPath);
  const skills = await Promise.all(names.map((name) => readInstalledSkill(target, trashPath, name)));
  return skills
    .filter((skill): skill is InstalledSkill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function setSkillEnabled(target: CodexTarget, skillName: string, enabled: boolean) {
  const codexHome = requireTargetCodexHome(target);
  const safeName = requireSafeSkillName(skillName);
  const activeName = stripDisabledSuffix(safeName);
  const sourceName = enabled ? `${activeName}.disabled` : activeName;
  const destinationName = enabled ? activeName : `${activeName}.disabled`;
  const skillsPath = target.kind === "wsl" ? path.posix.join(codexHome, "skills") : path.join(codexHome, "skills");
  const sourcePath = target.kind === "wsl" ? path.posix.join(skillsPath, sourceName) : path.join(skillsPath, sourceName);
  const destinationPath = target.kind === "wsl" ? path.posix.join(skillsPath, destinationName) : path.join(skillsPath, destinationName);

  if (target.kind === "wsl") {
    await runWslShell(target.distro!, [
      `test -d ${shellQuote(sourcePath)}`,
      `if [ -e ${shellQuote(destinationPath)} ]; then echo ${shellQuote("目标 skill 已存在。")} >&2; exit 17; fi`,
      `mv -- ${shellQuote(sourcePath)} ${shellQuote(destinationPath)}`
    ].join("\n"));
    return { renamedTo: destinationPath };
  }

  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`未找到 skill：${safeName}`);
  if (await pathExists(destinationPath)) throw new Error("目标 skill 已存在。");
  await fs.rename(sourcePath, destinationPath);
  return { renamedTo: destinationPath };
}

export async function deleteSkill(target: CodexTarget, skillName: string) {
  const codexHome = requireTargetCodexHome(target);
  const safeName = requireSafeSkillName(skillName);
  const skillsPath = target.kind === "wsl" ? path.posix.join(codexHome, "skills") : path.join(codexHome, "skills");
  const sourcePath = target.kind === "wsl" ? path.posix.join(skillsPath, safeName) : path.join(skillsPath, safeName);
  const trashPath =
    target.kind === "wsl"
      ? path.posix.join(codexHome, ".visual-console-trash", "skills", `${safeName}-${Date.now()}`)
      : path.join(codexHome, ".visual-console-trash", "skills", `${safeName}-${Date.now()}`);

  if (target.kind === "wsl") {
    await runWslShell(target.distro!, [
      `test -d ${shellQuote(sourcePath)}`,
      `mkdir -p -- ${shellQuote(path.posix.dirname(trashPath))}`,
      `mv -- ${shellQuote(sourcePath)} ${shellQuote(trashPath)}`
    ].join("\n"));
    return { movedTo: trashPath };
  }

  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`未找到 skill：${safeName}`);
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.rename(sourcePath, trashPath);
  return { movedTo: trashPath };
}

export async function restoreSkill(target: CodexTarget, skillName: string) {
  const codexHome = requireTargetCodexHome(target);
  const safeName = requireSafeSkillName(skillName);
  const activeName = trashSkillActiveName(safeName);
  const trashPath =
    target.kind === "wsl"
      ? path.posix.join(codexHome, ".visual-console-trash", "skills", safeName)
      : path.join(codexHome, ".visual-console-trash", "skills", safeName);
  const restoredPath = target.kind === "wsl"
    ? path.posix.join(codexHome, "skills", activeName)
    : path.join(codexHome, "skills", activeName);

  if (target.kind === "wsl") {
    await runWslShell(target.distro!, [
      `test -d ${shellQuote(trashPath)}`,
      `if [ -e ${shellQuote(restoredPath)} ]; then echo ${shellQuote("目标 skill 已存在，无法恢复。")} >&2; exit 17; fi`,
      `mkdir -p -- ${shellQuote(path.posix.dirname(restoredPath))}`,
      `mv -- ${shellQuote(trashPath)} ${shellQuote(restoredPath)}`
    ].join("\n"));
    return { restoredTo: restoredPath };
  }

  const stat = await fs.stat(trashPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`未在回收站找到 skill：${safeName}`);
  if (await pathExists(restoredPath)) throw new Error("目标 skill 已存在，无法恢复。");
  await fs.mkdir(path.dirname(restoredPath), { recursive: true });
  await fs.rename(trashPath, restoredPath);
  return { restoredTo: restoredPath };
}

export async function purgeSkill(target: CodexTarget, skillName: string) {
  const codexHome = requireTargetCodexHome(target);
  const safeName = requireSafeSkillName(skillName);
  const trashPath =
    target.kind === "wsl"
      ? path.posix.join(codexHome, ".visual-console-trash", "skills", safeName)
      : path.join(codexHome, ".visual-console-trash", "skills", safeName);

  if (target.kind === "wsl") {
    await runWslShell(target.distro!, [
      `test -d ${shellQuote(trashPath)}`,
      `rm -rf -- ${shellQuote(trashPath)}`
    ].join("\n"));
    return { deleted: trashPath };
  }

  const stat = await fs.stat(trashPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`未在回收站找到 skill：${safeName}`);
  await fs.rm(trashPath, { recursive: true, force: true });
  return { deleted: trashPath };
}

export async function getSkillFolderPath(target: CodexTarget, skillName: string) {
  const codexHome = requireTargetCodexHome(target);
  const safeName = requireSafeSkillName(skillName);
  return target.kind === "wsl"
    ? path.posix.join(codexHome, "skills", safeName)
    : path.join(codexHome, "skills", safeName);
}

function requireTargetCodexHome(target: CodexTarget) {
  const codexHome = target.codexHome || (target.kind === "local" ? getCodexHome() : "");
  if (!codexHome) throw new Error("当前目标未找到 Codex 目录，无法导入 skill。");
  return codexHome;
}

function requireSafeSkillName(name: string) {
  const trimmed = name.trim();
  if (!isSafeSkillName(trimmed)) throw new Error("skill name 无效。");
  return trimmed;
}

async function listLocalSkillNames(skillsPath: string) {
  try {
    const entries = await fs.readdir(skillsPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function listWslSkillNames(target: CodexTarget, skillsPath: string) {
  try {
    const output = await runWslShell(target.distro!, `find ${shellQuote(skillsPath)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'`);
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function readInstalledSkill(target: CodexTarget, skillsPath: string, directoryName: string): Promise<InstalledSkill | null> {
  const enabled = !directoryName.endsWith(".disabled");
  const displayName = stripDisabledSuffix(directoryName);
  const skillPath = target.kind === "wsl" ? path.posix.join(skillsPath, directoryName) : path.join(skillsPath, directoryName);
  const skillFilePath = target.kind === "wsl" ? path.posix.join(skillPath, "SKILL.md") : path.join(skillPath, "SKILL.md");

  try {
    const content = target.kind === "wsl" ? await wslReadFile(target.distro!, skillFilePath) : await fs.readFile(skillFilePath, "utf8");
    const frontmatter = extractFrontmatter(content);
    return {
      name: frontmatter.name?.trim() || displayName,
      description: frontmatter.description?.trim() || "",
      path: skillPath,
      enabled,
      sourceName: directoryName
    };
  } catch {
    return {
      name: displayName,
      description: "",
      path: skillPath,
      enabled,
      sourceName: directoryName
    };
  }
}

function stripDisabledSuffix(name: string) {
  return name.endsWith(".disabled") ? name.slice(0, -".disabled".length) : name;
}

function trashSkillActiveName(name: string) {
  return name.replace(/-\d+$/, "");
}

async function readSkillMetadata(skillFilePath: string) {
  const stat = await fs.stat(skillFilePath).catch(() => null);
  if (!stat?.isFile()) throw new Error("未找到 SKILL.md。");
  if (stat.size > MAX_SKILL_MD_BYTES) throw new Error("SKILL.md 过大，拒绝导入。");

  const content = await fs.readFile(skillFilePath, "utf8");
  const frontmatter = extractFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();

  if (!name) throw new Error("SKILL.md 缺少 frontmatter 字段：name。");
  if (!description) throw new Error("SKILL.md 缺少 frontmatter 字段：description。");
  if (!isSafeSkillName(name)) {
    throw new Error("skill name 不能包含路径分隔符或控制字符，且长度不超过 64。");
  }

  return { name, description };
}

function extractFrontmatter(content: string) {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("SKILL.md 必须以 YAML frontmatter 开头。");

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    fields[fieldMatch[1]] = unquoteYamlScalar(fieldMatch[2]);
  }
  return fields;
}

function unquoteYamlScalar(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSafeSkillName(name: string) {
  if (!name || Array.from(name).length > 64) return false;
  if (name === "." || name === "..") return false;
  return !/[\\/\0<>:"|?*\u0000-\u001F]/.test(name);
}

async function copySkillDirectory(sourcePath: string, destinationPath: string) {
  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const sourceEntryPath = path.join(sourcePath, entry.name);
    const destinationEntryPath = path.join(destinationPath, entry.name);

    if (entry.isDirectory()) {
      await copySkillDirectory(sourceEntryPath, destinationEntryPath);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(sourceEntryPath, destinationEntryPath);
    }
  }
}

async function importWslSkill(plan: SkillImportPlan) {
  if (!plan.target.distro) throw new Error("缺少 WSL 发行版名称。");
  const parentPath = path.posix.dirname(plan.destinationPath);
  const tempPath = path.posix.join(parentPath, `.import-${process.pid}-${Date.now()}`);
  const backupPath = path.posix.join(parentPath, `.backup-${plan.skillName}-${process.pid}-${Date.now()}`);

  if (plan.kind === "file") {
    const content = await fs.readFile(plan.sourcePath, "utf8");
    await wslWriteFile(plan.target.distro!, path.posix.join(tempPath, "SKILL.md"), content);
  } else {
    await copyDirectoryToWsl(plan.target, plan.sourcePath, tempPath);
  }

  try {
    await replaceWslDirectory(plan.target, plan.destinationPath, tempPath, backupPath, plan.exists);
  } catch (error) {
    await runWslShell(plan.target.distro!, `rm -rf -- ${shellQuote(tempPath)}`).catch(() => undefined);
    if (plan.exists && !(await wslPathExists(plan.target.distro!, plan.destinationPath)) && (await wslPathExists(plan.target.distro!, backupPath))) {
      await runWslShell(plan.target.distro!, `mv -- ${shellQuote(backupPath)} ${shellQuote(plan.destinationPath)}`).catch(() => undefined);
    }
    throw error;
  }
}

async function copyDirectoryToWsl(target: CodexTarget, sourcePath: string, destinationPath: string) {
  if (!target.distro) throw new Error("缺少 WSL 发行版名称。");
  await assertSourceVisibleToWsl(target, sourcePath);
  const script = [
    `source_path=$(wslpath -a ${shellQuote(sourcePath)})`,
    `mkdir -p -- ${shellQuote(destinationPath)}`,
    `cp -a "$source_path"/. ${shellQuote(destinationPath)}/`,
    `rm -rf -- ${shellQuote(path.posix.join(destinationPath, ".git"))} ${shellQuote(path.posix.join(destinationPath, "node_modules"))}`
  ].join("\n");
  await runWslShell(target.distro!, script);
}

async function assertSourceVisibleToWsl(target: CodexTarget, sourcePath: string) {
  try {
    await runWslShell(target.distro!, [
      `source_path=$(wslpath -a ${shellQuote(sourcePath)})`,
      `test -e "$source_path"`
    ].join("\n"));
  } catch {
    throw new Error("当前 WSL 发行版无法访问所选 skill 目录，请选择挂载到 WSL 内的路径。");
  }
}

async function replaceWslDirectory(
  target: CodexTarget,
  destinationPath: string,
  tempPath: string,
  backupPath: string,
  exists: boolean
) {
  const commands = [
    `mkdir -p -- ${shellQuote(path.posix.dirname(destinationPath))}`,
    exists ? `mv -- ${shellQuote(destinationPath)} ${shellQuote(backupPath)}` : "",
    `mv -- ${shellQuote(tempPath)} ${shellQuote(destinationPath)}`,
    exists ? `rm -rf -- ${shellQuote(backupPath)}` : ""
  ].filter(Boolean);
  await runWslShell(target.distro!, commands.join("\n"));
}
