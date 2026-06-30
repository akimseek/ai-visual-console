import { useEffect, useState } from "react";
import type { InstalledSkill } from "./types";
import { skillSourceName } from "./sessionFormat";

export type SkillView = "active" | "trash";

// Skill 管理（列表 / 启用禁用 / 删除 / 回收站）的状态与副作用，从 App.tsx 抽出为自定义 Hook。
export function useSkills({
  targetId,
  setNotice,
  setError
}: {
  targetId: string;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}) {
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [skillView, setSkillView] = useState<SkillView>("active");
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  useEffect(() => {
    return window.codexConsole.onOpenSkillManager(() => {
      void openSkillManager();
    });
    // 仅在目标变化时重订阅 IPC；openSkillManager 每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  async function openSkillManager() {
    setSkillManagerOpen(true);
    await loadSkills(skillView);
  }

  async function loadSkills(nextSkillView: SkillView = skillView) {
    if (!targetId) return;
    setSkillsLoading(true);
    setError("");
    try {
      setSkills(
        nextSkillView === "trash"
          ? await window.codexConsole.listTrashSkills(targetId)
          : await window.codexConsole.listSkills(targetId)
      );
    } catch (skillError: any) {
      setError(skillError?.message || "加载 skill 失败。");
      setSkills([]);
    } finally {
      setSkillsLoading(false);
    }
  }

  async function importSkillFromManager() {
    if (!targetId) return;
    try {
      const imported = await window.codexConsole.importSkill(targetId);
      if (!imported) return;
      setSkillView("active");
      await loadSkills("active");
      setNotice(`已导入 skill：${imported.skillName}`);
    } catch (skillError: any) {
      if (skillError?.message) setError(skillError.message);
    }
  }

  async function toggleSkill(skill: InstalledSkill) {
    try {
      await window.codexConsole.setSkillEnabled(targetId, skillSourceName(skill), !skill.enabled);
      await loadSkills("active");
      setNotice(skill.enabled ? "Skill 已禁用。" : "Skill 已启用。");
    } catch (skillError: any) {
      setError(skillError?.message || "更新 skill 失败。");
    }
  }

  async function deleteInstalledSkill(skill: InstalledSkill) {
    const confirmed = window.confirm(`移除此 skill？\n\n${skill.name}`);
    if (!confirmed) return;
    try {
      await window.codexConsole.deleteSkill(targetId, skillSourceName(skill));
      await loadSkills("active");
      setNotice("Skill 已移动到回收目录。");
    } catch (skillError: any) {
      setError(skillError?.message || "移除 skill 失败。");
    }
  }

  async function restoreInstalledSkill(skill: InstalledSkill) {
    try {
      await window.codexConsole.restoreSkill(targetId, skillSourceName(skill));
      await loadSkills("trash");
      setNotice("Skill 已恢复。");
    } catch (skillError: any) {
      setError(skillError?.message || "恢复 skill 失败。");
    }
  }

  async function purgeInstalledSkill(skill: InstalledSkill) {
    const confirmed = window.confirm(`彻底删除此 skill？\n\n${skill.name}`);
    if (!confirmed) return;
    try {
      await window.codexConsole.purgeSkill(targetId, skillSourceName(skill));
      await loadSkills("trash");
      setNotice("Skill 已彻底删除。");
    } catch (skillError: any) {
      setError(skillError?.message || "彻底删除 skill 失败。");
    }
  }

  async function switchSkillView(nextSkillView: SkillView) {
    setSkillView(nextSkillView);
    await loadSkills(nextSkillView);
  }

  return {
    skillManagerOpen,
    setSkillManagerOpen,
    skillView,
    skills,
    skillsLoading,
    openSkillManager,
    loadSkills,
    importSkillFromManager,
    toggleSkill,
    deleteInstalledSkill,
    restoreInstalledSkill,
    purgeInstalledSkill,
    switchSkillView
  };
}
