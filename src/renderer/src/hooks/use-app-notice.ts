import { useEffect, useState } from "react";

export type NoticeState = {
  message: string;
  tone?: "success" | "error";
  actionLabel?: string;
  onAction?: () => void;
};

export function useAppNotice() {
  const [notice, setNoticeState] = useState<NoticeState | null>(null);

  function setNotice(
    message: string,
    action?: { label: string; onClick: () => void },
    tone: NoticeState["tone"] = "success"
  ) {
    setNoticeState(message ? { message, tone, actionLabel: action?.label, onAction: action?.onClick } : null);
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, setNotice };
}
