import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayUsageDimension, GatewayUsageReport } from "../../types";
import { Dialog } from "../../components/dialog";
import { IconButton } from "../../components/icon-button";
import { captureError } from "../../hooks/error-utils";
import { formatCompactNumber } from "../sessions/session-format";

export type UsageDatePreset = "today" | "7d" | "30d" | "all" | "custom";
type UsageView = "vendors" | "models";

// 统计日期使用本地自然日边界，保证界面选择的日期与 SQLite 查询范围一致。
export function getGatewayUsageDateRange(preset: UsageDatePreset, from: string, to: string, now = new Date()) {
  if (preset === "all") return { periodStart: "", periodEnd: "" };
  if (preset === "custom") {
    if (!from || !to) return { periodStart: "", periodEnd: "", error: "请选择完整的起止日期。" };
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T23:59:59.999`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return { periodStart: "", periodEnd: "", error: "起始日期不能晚于结束日期。" };
    }
    return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (preset === "7d") start.setDate(start.getDate() - 6);
  if (preset === "30d") start.setDate(start.getDate() - 29);
  return { periodStart: start.toISOString(), periodEnd: now.toISOString() };
}

export function GatewayUsageDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<GatewayUsageReport | null>(null);
  const [preset, setPreset] = useState<UsageDatePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [view, setView] = useState<UsageView>("vendors");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const dateRange = useMemo(() => getGatewayUsageDateRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const refresh = useCallback(async () => {
    if (dateRange.error) {
      setReport(null);
      setError(dateRange.error);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await window.codexConsole.getGatewayUsageReport(dateRange.periodStart, dateRange.periodEnd);
      setReport(next);
    } catch (cause: unknown) {
      setError(captureError(cause, "gatewayUsageReport"));
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = report?.summary;
  const dimensions = view === "vendors" ? report?.vendors || [] : report?.models || [];
  return (
    <Dialog title="Gateway 用量与费用" onClose={onClose} className="gateway-usage-dialog">
      <div className="gateway-usage-toolbar">
        <div className="gateway-usage-filters" aria-label="用量统计时间范围">
          <span className="gateway-usage-filter-label">统计范围</span>
          <select aria-label="用量时间范围" value={preset} onChange={(event) => setPreset(event.target.value as UsageDatePreset)}>
            <option value="today">今天</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="all">全部时间</option>
            <option value="custom">自定义</option>
          </select>
          <div className={`gateway-usage-custom-range${preset === "custom" ? " is-visible" : ""}`}>
            {preset === "custom" ? <>
              <input aria-label="用量开始日期" type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
              <span>至</span>
              <input aria-label="用量结束日期" type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
            </> : <span className="gateway-usage-range-placeholder">按预设范围统计</span>}
          </div>
        </div>
        <IconButton icon={RefreshCw} label="刷新用量统计" onClick={() => void refresh()} disabled={loading} className={loading ? "is-spinning" : ""} />
      </div>

      {error && <p className="gateway-usage-error" role="status">{error}</p>}
      {summary && <UsageSummary summary={summary} />}
      {loading && !report ? <p className="gateway-usage-empty">正在读取用量统计...</p> : !report ? <p className="gateway-usage-empty">暂无 Gateway 用量记录。</p> : <>
        <div className="gateway-usage-tabs" role="tablist" aria-label="用量统计维度">
          <button type="button" role="tab" aria-selected={view === "vendors"} className={view === "vendors" ? "active" : ""} onClick={() => setView("vendors")}>按供应商</button>
          <button type="button" role="tab" aria-selected={view === "models"} className={view === "models" ? "active" : ""} onClick={() => setView("models")}>按模型</button>
        </div>
        <UsageTable rows={dimensions} view={view} loading={loading} />
      </>}
    </Dialog>
  );
}

function UsageSummary({ summary }: { summary: GatewayUsageReport["summary"] }) {
  const successRate = summary.requestCount > 0 ? `${Math.round((summary.successCount / summary.requestCount) * 1000) / 10}%` : "-";
  return <div className="gateway-usage-summary">
    <SummaryMetric label="请求数" value={String(summary.requestCount)} />
    <SummaryMetric label="成功率" value={successRate} />
    <SummaryMetric label="失败 / 切换" value={`${summary.failureCount} / ${summary.switchedCount}`} />
    <SummaryMetric label="重试次数" value={String(summary.retryCount || 0)} />
    <SummaryMetric label="输入 Token" value={formatTokens(summary.inputTokens)} />
    <SummaryMetric label="输出 Token" value={formatTokens(summary.outputTokens)} />
    <SummaryMetric label="总费用" value={formatCost(summary.costUsd)} />
    <SummaryMetric label="平均耗时" value={formatGatewayUsageDuration(summary.averageDurationMs)} />
  </div>;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function UsageTable({ rows, view, loading }: { rows: GatewayUsageDimension[]; view: UsageView; loading: boolean }) {
  return <div className={`gateway-usage-table-wrap${loading ? " is-loading" : ""}`} aria-busy={loading}>
    <table className="gateway-usage-table">
      <thead><tr><th>{view === "vendors" ? "供应商" : "模型"}</th><th>Provider</th><th>请求</th><th>成功率</th><th>Token</th><th>费用</th><th>平均耗时</th><th>重试</th></tr></thead>
      <tbody>{rows.length === 0 ? <tr><td colSpan={8} className="gateway-usage-no-data">暂无记录</td></tr> : rows.map((row) => <UsageRow key={row.key} row={row} />)}</tbody>
    </table>
  </div>;
}

function UsageRow({ row }: { row: GatewayUsageDimension }) {
  const successRate = row.requestCount > 0 ? `${Math.round((row.successCount / row.requestCount) * 1000) / 10}%` : "-";
  return <tr>
    <td title={row.label}>{row.label}</td>
    <td>{formatProvider(row.providerId)}</td>
    <td>{row.requestCount}</td>
    <td>{successRate}</td>
    <td>{formatTokens(row.totalTokens)}</td>
    <td>{formatCost(row.costUsd)}</td>
    <td>{formatGatewayUsageDuration(row.averageDurationMs)}</td>
    <td>{row.retryCount}</td>
  </tr>;
}

function formatTokens(value?: number) {
  return typeof value === "number" ? formatCompactNumber(value) : "-";
}

function formatCost(value?: number) {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "-";
}

export function formatGatewayUsageDuration(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : "-";
}

function formatProvider(value: string) {
  const labels: Record<string, string> = { codex: "Codex", claude: "Claude Code", gemini: "Gemini", qoder: "Qoder CN" };
  return labels[value] || value;
}
