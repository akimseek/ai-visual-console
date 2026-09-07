import { useCallback, useEffect, useState } from "react";
import type { SessionQuickAccess } from "../../types";
import { EMPTY_SESSION_QUICK_ACCESS, normalizeSessionQuickAccess } from "./session-quick-access";

export function useSessionQuickAccess() {
  const [access, setAccess] = useState<SessionQuickAccess>(EMPTY_SESSION_QUICK_ACCESS);

  const refresh = useCallback(async () => {
    const next = await window.codexConsole.listSessionQuickAccess();
    setAccess(normalizeSessionQuickAccess(next));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setAccess(EMPTY_SESSION_QUICK_ACCESS));
  }, [refresh]);

  return { ...access, refresh };
}
