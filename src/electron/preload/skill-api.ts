import type { IpcRenderer } from "electron";
import type { InstalledSkill } from "../types";
import { invoke } from "./ipc-bridge";

// 技能列表、导入、启停、回收站和目录操作 API。
export function createSkillApi(ipc: IpcRenderer) {
  return {
    listSkills: (targetId: string) => invoke<InstalledSkill[]>(ipc, "skill:list", targetId),
    listTrashSkills: (targetId: string) => invoke<InstalledSkill[]>(ipc, "skill:list-trash", targetId),
    importSkill: (targetId: string) =>
      invoke<{ skillName: string; destinationPath: string } | undefined>(ipc, "skill:import", targetId),
    setSkillEnabled: (targetId: string, skillName: string, enabled: boolean) =>
      invoke<{ renamedTo: string }>(ipc, "skill:set-enabled", targetId, skillName, enabled),
    deleteSkill: (targetId: string, skillName: string) =>
      invoke<{ movedTo: string }>(ipc, "skill:delete", targetId, skillName),
    restoreSkill: (targetId: string, skillName: string) =>
      invoke<{ restoredTo: string }>(ipc, "skill:restore", targetId, skillName),
    purgeSkill: (targetId: string, skillName: string) =>
      invoke<{ deleted: string }>(ipc, "skill:purge", targetId, skillName),
    openSkillFolder: (targetId: string, skillName: string) =>
      invoke<void>(ipc, "skill:open-folder", targetId, skillName)
  };
}
