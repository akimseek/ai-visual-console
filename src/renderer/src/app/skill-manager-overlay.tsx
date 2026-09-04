import type { ComponentProps } from "react";
import { SkillManagerDialog } from "../features/skills/skill-manager-dialog";

type SkillManagerOverlayProps = ComponentProps<typeof SkillManagerDialog> & {
  open: boolean;
};

// Skill 管理浮层只负责展示和参数转发，Skill 状态与业务操作仍由 App.tsx 管理。
export function SkillManagerOverlay({ open, ...dialogProps }: SkillManagerOverlayProps) {
  if (!open) return null;
  return <SkillManagerDialog {...dialogProps} />;
}
