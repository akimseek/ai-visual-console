import { useMemo, useState } from "react";
import type { AiSession } from "../types";

export function useBatchSelection(sessions: AiSession[], filtered: AiSession[]) {
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const selectedBatchSessions = useMemo(
    () => sessions.filter((session) => selectedBatchIds.includes(session.id)),
    [sessions, selectedBatchIds]
  );
  const allVisibleSelected = filtered.length > 0 && filtered.every((session) => selectedBatchIds.includes(session.id));

  function toggleBatchSelection(sessionId: string) {
    setSelectedBatchIds((current) =>
      current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId]
    );
  }

  function toggleAllVisibleSessions() {
    const visibleIds = filtered.map((session) => session.id);
    setSelectedBatchIds((current) => {
      if (visibleIds.length > 0 && visibleIds.every((id) => current.includes(id))) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      return Array.from(new Set([...current, ...visibleIds]));
    });
  }

  return {
    selectedBatchIds,
    setSelectedBatchIds,
    selectedBatchSessions,
    allVisibleSelected,
    toggleBatchSelection,
    toggleAllVisibleSessions
  };
}
