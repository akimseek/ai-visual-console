import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiVendor, GatewayFailureDiagnostic } from "../../types";
import { Dialog } from "../../components/dialog";
import { IconButton } from "../../components/icon-button";
import { Pagination } from "../../components/pagination";
import { captureError } from "../../hooks/error-utils";
import type { GatewayFailureOutcomeFilter } from "../../types";
import { formatGatewayFailure } from "./use-workbench-usage";
import { useVendorData } from "../vendors/vendor-context";
import { PAGINATION_DEFAULT_PAGE_SIZE } from "../../../../shared/constants";

export type FailureDatePreset = "all" | "today" | "7d" | "30d" | "custom";

// 日期筛选使用本地自然日边界，避免用户选择的日期因 UTC 转换而前后偏移。
export function getGatewayFailureDateRange(preset: FailureDatePreset, from: string, to: string, now = new Date()) {
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

export function GatewayFailureDialog({ onClose }: { onClose: () => void }) {
  const vendors = useVendorData();
  const [items, setItems] = useState<GatewayFailureDiagnostic[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [vendorFilter, setVendorFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState<GatewayFailureOutcomeFilter>("");
  const [datePreset, setDatePreset] = useState<FailureDatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [pageSize, setPageSize] = useState(PAGINATION_DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const dateRange = useMemo(() => getGatewayFailureDateRange(datePreset, customFrom, customTo), [datePreset, customFrom, customTo]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    if (dateRange.error) {
      setLoading(false);
      setItems([]);
      setTotal(0);
      setError(dateRange.error);
      return;
    }
    try {
      const result = await window.codexConsole.getGatewayFailureDiagnostics(page, pageSize, vendorFilter, outcomeFilter, dateRange.periodStart, dateRange.periodEnd);
      setItems(result.items);
      setTotal(result.total);
    } catch (cause: unknown) {
      setError(captureError(cause, "gatewayFailureDiagnostics"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, vendorFilter, outcomeFilter, dateRange]);

  function updateVendorFilter(value: string) {
    setVendorFilter(value);
    setPage(1);
  }

  function updateOutcomeFilter(value: GatewayFailureOutcomeFilter) {
    setOutcomeFilter(value);
    setPage(1);
  }

  function updateDatePreset(value: FailureDatePreset) {
    setDatePreset(value);
    setPage(1);
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Dialog title="Gateway 异常诊断" onClose={onClose} className="gateway-failure-dialog">
      <div className="gateway-failure-dialog-toolbar">
        <div className="gateway-failure-dialog-filters" aria-label="异常记录筛选">
          <select aria-label="按供应商筛选" value={vendorFilter} onChange={(event) => updateVendorFilter(event.target.value)}>
            <option value="">全部供应商</option>
            {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
          </select>
          <select aria-label="按异常类型筛选" value={outcomeFilter} onChange={(event) => updateOutcomeFilter(event.target.value as GatewayFailureOutcomeFilter)}>
            <option value="">全部类型</option>
            <option value="error">请求失败</option>
            <option value="timeout">请求超时</option>
          </select>
          <select aria-label="按时间范围筛选" value={datePreset} onChange={(event) => updateDatePreset(event.target.value as FailureDatePreset)}>
            <option value="all">全部时间</option>
            <option value="today">今天</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="custom">自定义</option>
          </select>
          {datePreset === "custom" && <>
            <input aria-label="开始日期" type="date" value={customFrom} onChange={(event) => { setCustomFrom(event.target.value); setPage(1); }} />
            <span className="gateway-failure-dialog-date-separator">至</span>
            <input aria-label="结束日期" type="date" value={customTo} onChange={(event) => { setCustomTo(event.target.value); setPage(1); }} />
          </>}
        </div>
        <IconButton icon={RefreshCw} label="刷新异常记录" onClick={() => void refresh()} disabled={loading} className={loading ? "is-spinning" : ""} />
      </div>
      {error && <p className="gateway-failure-dialog-error" role="status">{error}</p>}
      {loading && items.length === 0 ? <p className="gateway-failure-dialog-empty">正在读取异常记录...</p> : items.length === 0 ? <p className="gateway-failure-dialog-empty">暂无 Gateway 异常记录。</p> : (
        <div className={`gateway-failure-dialog-table-wrap${loading ? " is-loading" : ""}`} aria-busy={loading}>
          <table className="gateway-failure-dialog-table">
            <thead><tr><th>时间</th><th>供应商</th><th>结果</th><th>错误信息</th><th>重试</th><th>耗时</th></tr></thead>
            <tbody>{items.map((item, index) => <DiagnosticRow key={`${item.vendorId}-${item.createdAt}-${index}`} item={item} vendors={vendors} />)}</tbody>
          </table>
        </div>
      )}
      {!loading && !error && total > 0 && (
        <Pagination
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
          label="Gateway 异常分页"
        />
      )}
    </Dialog>
  );
}

function DiagnosticRow({ item, vendors }: { item: GatewayFailureDiagnostic; vendors: ApiVendor[] }) {
  const vendorName = vendors.find((vendor) => vendor.id === item.vendorId)?.name || "已删除供应商";
  return <tr>
    <td>{formatDiagnosticTime(item.createdAt)}</td>
    <td title={vendorName}>{vendorName}</td>
    <td>{formatGatewayFailure(item)}</td>
    <td title={item.errorMessage || item.errorCode || ""}>{item.errorMessage || item.errorCode || "-"}</td>
    <td>{item.retryCount}</td>
    <td>{formatDiagnosticDuration(item.durationMs)}</td>
  </tr>;
}

export function formatDiagnosticTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "时间未知";
  const date = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")}`;
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
  return `${date} ${clock}`;
}

export function formatDiagnosticDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}
