import { useEffect, useState } from "react";
import type { BranchPanelState } from "./branch-panel";
import type { AiSession, AiTarget } from "../../types";
import type { SessionView } from "./use-session-loader";
import { captureError } from "../../hooks/error-utils";

type UseSessionDetailsOptions = {
  targetId: string;
  selectedTarget?: AiTarget;
  activeSession: AiSession | null;
  view: SessionView;
  supportsBranch: boolean;
  notifyError: (message: string) => void;
};

export function useSessionDetails({
  targetId,
  selectedTarget,
  activeSession,
  view,
  supportsBranch,
  notifyError
}: UseSessionDetailsOptions) {
  const [detailDialogSession, setDetailDialogSession] = useState<AiSession | null>(null);
  const [detailTargetId, setDetailTargetId] = useState("");
  const [detailTarget, setDetailTarget] = useState<AiTarget | undefined>();
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<AiSession | null>(null);
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const [detailLoadError, setDetailLoadError] = useState("");
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [detailHasMore, setDetailHasMore] = useState(false);
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
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
    const sessionToLoad = detailDialogSession;
    if (!sessionToLoad) {
      setSelectedSessionDetails(null);
      setSelectedSessionLoading(false);
      setDetailLoadError("");
      setDetailHasMore(false);
      return;
    }

    let cancelled = false;
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(true);
    setDetailLoadError("");
    void window.codexConsole
      .getSessionMessagesPage(detailTargetId, sessionToLoad.id, -1, 100)
      .then((page) => {
        if (cancelled) return;
        const session = { ...sessionToLoad, preview: page.messages, previewOffset: page.offset, messageCount: Math.max(sessionToLoad.messageCount, page.offset + page.messages.length) };
        setSelectedSessionDetails(session);
        setDetailHasMore(page.offset > 0);
      })
      .catch((error) => {
        if (!cancelled) {
          const message = captureError(error, "loadSessionDetails", "加载完整会话失败。");
          setDetailLoadError(message);
          notifyError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // 详情仅请求首个消息页；进入终端和详情首屏都不读取完整 JSONL。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTargetId, detailDialogSession?.id, detailRetryKey]);

  useEffect(() => {
    if (detailDialogSession) return;
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(false);
    setBranchPanel(null);
  }, [activeSession?.id, detailDialogSession]);

  useEffect(() => {
    const session = selectedSessionDetails;
    if (!detailDialogSession || !detailTargetId || !session || view !== "active" || !supportsBranch) {
      setBranchPanel(null);
      return;
    }

    let cancelled = false;
    setBranchPanel((current) => ({
      targetId: detailTargetId,
      sessionId: session.id,
      parent: current?.targetId === detailTargetId && current.sessionId === session.id ? current.parent : null,
      children: current?.targetId === detailTargetId && current.sessionId === session.id ? current.children : [],
      loading: true
    }));
    const parentSessionId = session.metadata?.branch?.parentSessionId;
    // 分支关系只能在详情来源目标内解析；元数据中的旧目标标记可能来自早期跨环境回归。
    const parentTargetId = detailTargetId;
    void Promise.all([
      parentSessionId
        ? window.codexConsole.getSessionSummary(parentTargetId, parentSessionId).catch((error) => {
          captureError(error, `loadParentSession:${parentSessionId}`);
          return null;
        })
        : Promise.resolve(null),
      window.codexConsole.listSessionChildren(detailTargetId, session.id).catch((error) => {
        captureError(error, `loadSessionChildren:${session.id}`);
        return [];
      })
    ]).then(([parent, children]) => {
      if (!cancelled) setBranchPanel({ targetId: detailTargetId, sessionId: session.id, parent, children, loading: false });
    });
    return () => {
      cancelled = true;
    };
    // 仅会话、父分支和能力变化时重新读取关系。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTargetId, view, supportsBranch, detailDialogSession?.id, selectedSessionDetails?.id, selectedSessionDetails?.metadata?.branch?.parentSessionId]);

  function openSessionDetail(session: AiSession, sourceTargetId = targetId, sourceTarget = selectedTarget) {
    setDetailTargetId(sourceTargetId);
    setDetailTarget(sourceTarget);
    setDetailDialogSession(session);
  }

  async function refreshSessionSnapshot(nextTargetId: string, sessionId: string, filePath?: string) {
    try {
      const session = await window.codexConsole.getSession(nextTargetId, sessionId, filePath ? { filePath } : undefined);
      setSelectedSessionDetails((current) => (current?.id === session.id ? session : current));
      setDetailDialogSession((current) => (current?.id === session.id ? session : current));
      return session;
    } catch (error) {
      captureError(error, `refreshSessionSnapshot:${sessionId}`);
      return null;
    }
  }

  function resetSessionDetails() {
    setDetailDialogSession(null);
    setDetailTargetId("");
    setDetailTarget(undefined);
    setSelectedSessionDetails(null);
    setSelectedSessionLoading(false);
    setBranchPanel(null);
    setDetailHasMore(false);
    setDetailLoadingMore(false);
    setDetailLoadError("");
  }

  async function loadMoreDetailMessages() {
    if (!detailDialogSession || !selectedSessionDetails || detailLoadingMore || !detailHasMore) return;
    setDetailLoadingMore(true);
    try {
      const offset = Math.max(0, (selectedSessionDetails.previewOffset || 0) - 100);
      const page = await window.codexConsole.getSessionMessagesPage(detailTargetId, detailDialogSession.id, offset, 100);
      setSelectedSessionDetails((current) => current?.id === detailDialogSession.id
        ? { ...current, preview: [...page.messages, ...current.preview], previewOffset: page.offset }
        : current);
      setDetailHasMore(page.offset > 0);
    } catch (error) {
      notifyError(captureError(error, "loadMoreSessionDetails", "加载更多会话消息失败。"));
    } finally {
      setDetailLoadingMore(false);
    }
  }

  function retryDetailMessages() {
    setDetailRetryKey((value) => value + 1);
  }

  return {
    detailDialogSession,
    detailTargetId,
    detailTarget,
    openSessionDetail,
    setDetailDialogSession,
    selectedSessionDetails,
    setSelectedSessionDetails,
    selectedSessionLoading,
    setSelectedSessionLoading,
    detailLoadError,
    retryDetailMessages,
    branchPanel,
    detailHasMore,
    detailLoadingMore,
    loadMoreDetailMessages,
    setBranchPanel,
    refreshSessionSnapshot,
    resetSessionDetails
  };
}
