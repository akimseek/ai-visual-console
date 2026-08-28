import type { InstalledSkill } from "../../types";
import { skillSourceName } from "../sessions/session-format";
import type { SkillView } from "./use-skills";
import { Dialog } from "../../components/dialog";

// Skill 管理弹框（已安装 / 回收站两视图），从 App.tsx 的内联 JSX 抽出为独立展示组件。
export function SkillManagerDialog({
  skills,
  skillView,
  skillsLoading,
  targetId,
  targetLabel,
  onClose,
  onSwitchView,
  onRefresh,
  onImport,
  onToggle,
  onDelete,
  onRestore,
  onPurge
}: {
  skills: InstalledSkill[];
  skillView: SkillView;
  skillsLoading: boolean;
  targetId: string;
  targetLabel: string;
  onClose: () => void;
  onSwitchView: (view: SkillView) => void;
  onRefresh: () => void;
  onImport: () => void;
  onToggle: (skill: InstalledSkill) => void;
  onDelete: (skill: InstalledSkill) => void;
  onRestore: (skill: InstalledSkill) => void;
  onPurge: (skill: InstalledSkill) => void;
}) {
  return (
    <Dialog
      title="Skill 管理"
      onClose={onClose}
      className="skill-manager-dialog"
      closeOnOverlay={false}
    >
      <div className="skill-manager-toolbar">
        <span>{targetLabel || "当前目标"}</span>
        <div>
          <div className="skill-view-switch" role="tablist" aria-label="Skill 视图">
            <button
              type="button"
              className={skillView === "active" ? "active" : ""}
              onClick={() => onSwitchView("active")}
              disabled={skillsLoading}
            >
              已安装
            </button>
            <button
              type="button"
              className={skillView === "trash" ? "active" : ""}
              onClick={() => onSwitchView("trash")}
              disabled={skillsLoading}
            >
              回收站
            </button>
          </div>
          <button type="button" className="secondary" onClick={onRefresh} disabled={skillsLoading}>
            刷新
          </button>
          <button type="button" onClick={onImport} disabled={skillsLoading || skillView !== "active"}>
            导入 skill
          </button>
        </div>
      </div>
      <section className="skill-list" aria-label={skillView === "trash" ? "回收站 skill" : "已安装 skill"}>
        {skillsLoading && <div className="empty-state">正在加载 skill...</div>}
        {!skillsLoading && skills.length === 0 && (
          <div className="empty-state">{skillView === "trash" ? "回收站为空。" : "未找到 skill。"}</div>
        )}
        {skills.map((skill) => (
          <article key={skill.sourceName || `${skill.name}-${skill.enabled ? "on" : "off"}`} className={`skill-item ${skill.enabled ? "" : "disabled"}`}>
            <div>
              <h3>{skill.name}</h3>
              <p>{skill.description || "无描述"}</p>
              <code title={skill.path}>{skill.path}</code>
            </div>
            <div className="skill-actions">
              {skillView === "active" ? (
                <>
                  <button type="button" className="secondary" onClick={() => void window.codexConsole.openSkillFolder(targetId, skillSourceName(skill))}>
                    打开目录
                  </button>
                  <button type="button" className="secondary" onClick={() => onToggle(skill)}>
                    {skill.enabled ? "禁用" : "启用"}
                  </button>
                  <button type="button" className="danger" onClick={() => onDelete(skill)}>
                    移除
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="secondary" onClick={() => onRestore(skill)}>
                    恢复
                  </button>
                  <button type="button" className="danger" onClick={() => onPurge(skill)}>
                    彻底删除
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </section>
    </Dialog>
  );
}
