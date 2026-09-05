import { useCallback, useEffect, useState } from "react";
import type { GatewayRecentFailure, GatewayUsageSummary } from "../../types";
import { captureError } from "../../hooks/error-utils";
import { formatCompactNumber } from "../sessions/session-format";

// 使用本地日期边界生成当天统计范围，再转换为 ISO 传给主进程，避免 UTC 零点切换导致本地“今日”统计跨日。
export function getTodayGatewayUsagePeriod(now = new Date()) {
  const periodStart = new Date(now);
  periodStart.setHours(0, 0, 0, 0);
  return { periodStart: periodStart.toISOString(), periodEnd: now.toISOString() };
}

export function formatGatewayUsageSummary(summary: GatewayUsageSummary) {
  const successRate = summary.requestCount > 0
    ? `${Math.round((summary.successCount / summary.requestCount) * 1000) / 10}%`
    : "-";
  return {
    requestCount: String(summary.requestCount),
    successRate,
    switchedCount: String(summary.switchedCount),
    totalTokens: formatCompactNumber(summary.totalTokens),
    cost: typeof summary.costUsd === "number" ? `$${summary.costUsd.toFixed(4)}` : "-"
  };
}

// 原始错误文本可能包含上游实现细节，工作台仅给出可安全展示的异常分类。
export function formatGatewayFailure(failure: GatewayRecentFailure) {
  if (failure.outcome === "timeout") return "请求超时";
  return "请求失败";
}

// 工作台仅在挂载和用户手动刷新时读取当天聚合统计，不建立后台轮询。
export function useWorkbenchUsage() {
  const [summary, setSummary] = useState<GatewayUsageSummary | null>(null);
  const [recentFailures, setRecentFailures] = useState<GatewayRecentFailure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { periodStart, periodEnd } = getTodayGatewayUsagePeriod();
      const [nextSummary, nextRecentFailures] = await Promise.all([
        window.codexConsole.getGatewayUsageSummary(periodStart, periodEnd),
        window.codexConsole.getGatewayRecentFailures()
      ]);
      setSummary(nextSummary);
      setRecentFailures(nextRecentFailures);
      // 用量与异常摘要来自同一批读取，二者完整返回后才更新成功时间。
      setLastUpdatedAt(new Date());
    } catch (cause: unknown) {
      setError(captureError(cause, "workbenchUsage"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, recentFailures, loading, error, lastUpdatedAt, refresh };
}
