import type { AiSession, AiTarget, TerminalAttentionKind, TerminalStatus, TerminalStatusEvent } from "../../types";

export type TerminalTab = {
  key: string;
  targetId: string;
  // 标签必须持有创建时的目标快照。切换标签时不能依赖当前左侧目标列表，
  // 否则跨平台标签在目标列表刷新后无法准确还原其运行上下文。
  target: AiTarget;
  session?: AiSession;
  title: string;
  cwd?: string;
  // 标签创建后目标列表可能因切换平台而替换，保留终端启动所需的配置快照。
  codexHome?: string;
  useCodexCwdFlag?: boolean;
  prompt?: string;
  cliArgs?: string;
  customTitle?: string;
  knownSessionIds?: string[];
  createdAt?: number;
};

export type TerminalTabAttention = {
  status: TerminalStatus;
  turnId?: number;
  kind?: TerminalAttentionKind;
  title?: string;
  detail?: string;
  unread: boolean;
  updatedAt: number;
};

export function applyTerminalStatus(current: TerminalTabAttention | undefined, event: TerminalStatusEvent): TerminalTabAttention {
  if (event.status === "running") {
    return { status: "running", unread: false, updatedAt: event.updatedAt };
  }
  const previous = current?.status === event.status && current?.title === event.attention?.title && current?.detail === event.attention?.detail;
  return {
    status: event.status,
    turnId: event.turnId,
    kind: event.attention?.kind,
    title: event.attention?.title,
    detail: event.attention?.detail,
    unread: previous ? current?.unread ?? true : true,
    updatedAt: event.updatedAt
  };
}

// 终端运行状态只服务于渲染层展示，不参与 PTY 启动、停止或会话文件写入。
export function upsertTerminalTab(tabs: TerminalTab[], tab: TerminalTab) {
  const index = tabs.findIndex((item) => item.key === tab.key);
  if (index === -1) return [...tabs, tab];
  return tabs.map((item) => (item.key === tab.key ? tab : item));
}

export function removeTerminalTabs(tabs: TerminalTab[], keys: Set<string>) {
  const firstClosedIndex = tabs.findIndex((tab) => keys.has(tab.key));
  if (firstClosedIndex === -1) return { tabs, fallback: null };
  const remaining = tabs.filter((tab) => !keys.has(tab.key));
  return {
    tabs: remaining,
    fallback: remaining[Math.max(0, firstClosedIndex - 1)] || remaining[0] || null
  };
}

export function omitTerminalTabRecords<T>(records: Record<string, T>, keys: Set<string>) {
  let changed = false;
  const next = { ...records };
  keys.forEach((key) => {
    if (!(key in next)) return;
    delete next[key];
    changed = true;
  });
  return changed ? next : records;
}
