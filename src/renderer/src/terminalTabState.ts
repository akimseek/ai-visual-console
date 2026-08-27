import type { AiSession } from "./types";

export type TerminalTab = {
  key: string;
  targetId: string;
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
