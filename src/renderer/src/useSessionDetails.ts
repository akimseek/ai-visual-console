import { useEffect, useState } from "react";
import type { BranchPanelState } from "./BranchPanel";
import type { AiSession } from "./types";
import type { SessionView } from "./useSessionLoader";

type UseSessionDetailsOptions = {
  targetId: string;
  activeSession: AiSession | null;
  selectedSession: AiSession | null;
  view: SessionView;
  supportsBranch: boolean;
  onSessionLoaded: (targetId: string, session: AiSession) => void;
  notifyError: (message: string) => void;
};

export function useSessionDetails({
  targetId,
  activeSession,
  selectedSession,
  view,
  supportsBranch,
  onSessionLoaded,
  notifyError
}: UseSessionDetailsOptions) {
  const [detailDialogSession, setDetailDialogSession] = useState<AiSession | null>(null);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<AiSession | null>(null);
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const [branchPanel, setBranchPanel] = useState<BranchPanelState | null>(null);

  useEffect(() => {
    if (!detailDialogSession) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailDialogSession(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailDialogSession]);

  useEffect(() => {
    const sessionToLoad = detailDialogSession || activeSession;
    if (!sessionToLoad) {
      setSelectedSessionDetails(null);
      setSelectedSessionLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(true);
    void window.codexConsole
      .getSession(targetId, sessionToLoad.id)
      .then((session) => {
        if (cancelled) return;
        setSelectedSessionDetails(session);
        onSessionLoaded(targetId, session);
      })
      .catch((error: any) => {
        if (!cancelled) notifyError(error?.message || "加载完整会话失败。");
      })
      .finally(() => {
        if (!cancelled) setSelectedSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // 只在目标或会话切换时读取完整 jsonl，回调由 App 保持最新业务语义。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, activeSession?.id, detailDialogSession?.id]);

  useEffect(() => {
    const session = selectedSessionDetails || selectedSession;
    if (!targetId || !session || view !== "active" || !supportsBranch) {
      setBranchPanel(null);
      return;
    }

    let cancelled = false;
    setBranchPanel((current) => ({
      sessionId: session.id,
      parent: current?.sessionId === session.id ? current.parent : null,
      children: current?.sessionId === session.id ? current.children : [],
      loading: true
    }));
    const parentSessionId = session.metadata?.branch?.parentSessionId;
    const parentTargetId = session.metadata?.branch?.parentTargetId || targetId;
    void Promise.all([
      parentSessionId ? window.codexConsole.getSession(parentTargetId, parentSessionId).catch(() => null) : Promise.resolve(null),
      window.codexConsole.listSessionChildren(targetId, session.id).catch(() => [])
    ]).then(([parent, children]) => {
      if (!cancelled) setBranchPanel({ sessionId: session.id, parent, children, loading: false });
    });
    return () => {
      cancelled = true;
    };
    // 仅会话、父分支和能力变化时重新读取关系。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, view, supportsBranch, selectedSession?.id, selectedSessionDetails?.id, selectedSessionDetails?.metadata?.branch?.parentSessionId]);

  async function refreshSessionSnapshot(nextTargetId: string, sessionId: string) {
    try {
      const session = await window.codexConsole.getSession(nextTargetId, sessionId);
      onSessionLoaded(nextTargetId, session);
      setSelectedSessionDetails((current) => (current?.id === session.id ? session : current));
      setDetailDialogSession((current) => (current?.id === session.id ? session : current));
      return session;
    } catch {
      return null;
    }
  }

  function resetSessionDetails() {
    setDetailDialogSession(null);
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(false);
    setBranchPanel(null);
  }

  return {
    detailDialogSession,
    setDetailDialogSession,
    selectedSessionDetails,
    setSelectedSessionDetails,
    selectedSessionLoading,
    setSelectedSessionLoading,
    branchPanel,
    setBranchPanel,
    refreshSessionSnapshot,
    resetSessionDetails
  };
}
