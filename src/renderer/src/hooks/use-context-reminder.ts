import { useEffect, useRef } from "react";
import type { AiSession } from "../types";
import { formatCompactNumber } from "../features/sessions/session-format";
import type { NoticeState } from "./use-app-notice";

export function useContextReminder({
  session,
  setNotice
}: {
  session: AiSession | null;
  setNotice: (message: string, action?: { label: string; onClick: () => void }, tone?: NoticeState["tone"]) => void;
}) {
  const reminderKeys = useRef(new Set<string>());

  useEffect(() => {
    const reminder = getContextReminder(session);
    if (!reminder || !session) return;
    const key = `${session.id}:${reminder.level}`;
    if (reminderKeys.current.has(key)) return;
    reminderKeys.current.add(key);
    setNotice(reminder.message);
    // 提醒以会话和告警等级去重；Token 每次更新时不重复打扰。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.usage?.contextPercent]);
}

function getContextReminder(session?: AiSession | null) {
  const percent = session?.usage?.contextPercent;
  if (!session || typeof percent !== "number" || percent < 60) return null;
  const left = session.usage?.contextLeftPercent;
  const used = formatCompactNumber(session.usage?.contextUsedTokens);
  const windowSize = formatCompactNumber(session.usage?.contextWindow);
  const suffix = typeof left === "number" ? `，剩余 ${left}%（${used} / ${windowSize}）` : "";
  if (percent >= 90) return { level: "danger", message: `上下文已使用 ${percent}%${suffix}，建议收束当前任务或创建新分支。` };
  if (percent >= 80) return { level: "warning", message: `上下文已使用 ${percent}%${suffix}，建议留意容量并适时拆分任务。` };
  return { level: "notice", message: `上下文已使用 ${percent}%${suffix}，后续长任务建议留意上下文。` };
}
