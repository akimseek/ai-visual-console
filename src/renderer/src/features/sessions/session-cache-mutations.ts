import type { AiSession } from "../../types";

// 详情刷新和重命名共用的纯缓存变更函数，避免不同调用方产生不一致的标题语义。
export function applySessionCustomTitle(
  session: AiSession,
  metadata: AiSession["metadata"]
) {
  const sourceTitle = session.sourceTitle || session.title;
  const hasMetadata = Boolean(metadata?.customTitle || metadata?.branch);
  return {
    ...session,
    title: metadata?.customTitle || sourceTitle,
    sourceTitle: metadata?.customTitle ? sourceTitle : undefined,
    metadata: hasMetadata ? metadata : undefined
  };
}
