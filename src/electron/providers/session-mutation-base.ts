import type { SessionBatchMutationResult, SessionMutationRef } from "../types";

export type SessionMutationView = "active" | "trash";

export type SessionMutationPlan<TSession> = {
  session: TSession;
  source: string;
  destination?: string;
  result: SessionMutationRef & { movedTo?: string; deleted?: string };
};

// Provider 共用批量会话变更的编排流程，具体路径校验和文件 I/O 仍由平台实现。
export async function planSessionMutationBatch<TSession>(
  sessions: SessionMutationRef[],
  view: SessionMutationView,
  resolve: (session: SessionMutationRef, view: SessionMutationView) => Promise<SessionMutationPlan<TSession>>
): Promise<SessionMutationPlan<TSession>[]> {
  if (sessions.length === 0) return [];
  return Promise.all(sessions.map((session) => resolve(session, view)));
}

export function mutationBatchResult<TSession>(plans: SessionMutationPlan<TSession>[]): SessionBatchMutationResult {
  return { processed: plans.map((plan) => plan.result) };
}
