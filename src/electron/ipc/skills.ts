import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { listTargets } from "../providers/ai-providers";
import {
  deleteSkill,
  getSkillFolderPath,
  importSkill,
  listSkills,
  listTrashSkills,
  planSkillImport,
  purgeSkill,
  restoreSkill,
  setSkillEnabled
} from "../skills/skills";
import type { CodexTarget } from "../types";
import { getProviderIdFromTargetId } from "../../shared/target-ids";
import { requireString, requireBoolean } from "./validation";

async function requireTargetById(targetId: string) {
  if (getProviderIdFromTargetId(targetId) === "gemini") {
    throw new Error("当前目标不支持 Codex Skill。");
  }
  const targets = await listTargets("codex");
  const target = targets.find((item) => item.id === targetId);
  if (target?.provider !== "codex" || !target.available || !target.codexHome) {
    throw new Error("当前目标不支持 Codex Skill。");
  }
  return target;
}

async function chooseSkillImportKind(owner: BrowserWindow | null) {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Markdown 文件", "skill 目录", "取消"],
    defaultId: 0,
    cancelId: 2,
    title: "导入 skill",
    message: "请选择导入类型",
    detail: "Markdown 文件可以是任意文件名，导入后会写入为 SKILL.md。skill 目录需要目录内已有 SKILL.md。"
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response === 0) return "file";
  if (result.response === 1) return "directory";
  return null;
}

async function importSkillWithDialog(owner: BrowserWindow | null, target: CodexTarget) {
  try {
    if (!target?.available || !target.codexHome) {
      throw new Error("当前目标未找到 Codex 目录，无法导入 skill。");
    }

    const importKind = await chooseSkillImportKind(owner);
    if (!importKind) return;

    const options: Electron.OpenDialogOptions = {
      title: importKind === "file" ? "导入 skill Markdown 文件" : "导入 skill 目录",
      buttonLabel: "导入",
      properties: importKind === "file" ? ["openFile"] : ["openDirectory"],
      filters: importKind === "file" ? [{ name: "Markdown", extensions: ["md"] }] : undefined
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return;

    const plan = await planSkillImport(result.filePaths[0], target);
    if (plan.exists) {
      const confirmOptions: Electron.MessageBoxOptions = {
        type: "warning",
        buttons: ["覆盖", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: "覆盖已有 skill",
        message: `skill 已存在：${plan.skillName}`,
        detail: `目标目录：${plan.destinationPath}`
      };
      const confirmed = owner
        ? await dialog.showMessageBox(owner, confirmOptions)
        : await dialog.showMessageBox(confirmOptions);
      if (confirmed.response !== 0) return;
    }

    const imported = await importSkill(plan, plan.exists);
    const successOptions: Electron.MessageBoxOptions = {
      type: "info",
      title: "导入 skill",
      message: `已导入 skill：${imported.skillName}`,
      detail: `位置：${imported.destinationPath}\n\n重启 Codex 后即可使用新 skill。`
    };
    if (owner) {
      await dialog.showMessageBox(owner, successOptions);
    } else {
      await dialog.showMessageBox(successOptions);
    }
    return imported;
  } catch (error) {
    const errorOptions: Electron.MessageBoxOptions = {
      type: "error",
      title: "导入 skill 失败",
      message: error instanceof Error ? error.message : "导入 skill 失败。"
    };
    if (owner) {
      await dialog.showMessageBox(owner, errorOptions);
    } else {
      await dialog.showMessageBox(errorOptions);
    }
    throw error;
  }
}

export function registerSkillIpcHandlers() {
  ipcMain.handle("skill:list", async (_event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return listSkills(target);
  });
  ipcMain.handle("skill:list-trash", async (_event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return listTrashSkills(target);
  });
  ipcMain.handle("skill:import", async (event, targetId: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return importSkillWithDialog(BrowserWindow.fromWebContents(event.sender), target);
  });
  ipcMain.handle("skill:set-enabled", async (_event, targetId: unknown, skillName: unknown, enabled: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return setSkillEnabled(target, requireString(skillName, "skillName"), requireBoolean(enabled, "enabled"));
  });
  ipcMain.handle("skill:delete", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return deleteSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:restore", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return restoreSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:purge", async (_event, targetId: unknown, skillName: unknown) => {
    const target = await requireTargetById(requireString(targetId, "targetId"));
    return purgeSkill(target, requireString(skillName, "skillName"));
  });
  ipcMain.handle("skill:open-folder", async (_event, targetId: unknown, skillName: unknown) => {
    const checkedTargetId = requireString(targetId, "targetId");
    const target = await requireTargetById(checkedTargetId);
    const folderPath = await getSkillFolderPath(target, requireString(skillName, "skillName"));
    if (target.kind === "wsl") {
      const uncPath = `\\\\wsl.localhost\\${target.distro}${folderPath.replace(/\//g, "\\")}`;
      return shell.openPath(uncPath);
    }
    return shell.openPath(folderPath);
  });
}
