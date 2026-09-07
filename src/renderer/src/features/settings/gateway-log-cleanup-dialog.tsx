import { RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiVendor,
  GatewayLogCleanupEntry,
  GatewayLogCleanupFilter,
  GatewayLogCleanupOutcome,
  GatewayLogCleanupResult,
  GatewayLogCleanupScope,
  GatewayLogCleanupSelection
} from "../../types";
import { Dialog } from "../../components/dialog";
import { IconButton } from "../../components/icon-button";
import { Pagination } from "../../components/pagination";
import { captureError } from "../../hooks/error-utils";
import { PAGINATION_DEFAULT_PAGE_SIZE } from "../../../../shared/constants";

type DatePreset = "all" | "today" | "7d" | "30d" | "custom";

export function GatewayLogCleanupDialog({ vendors, onClose, onDeleted }: { vendors: ApiVendor[]; onClose: () => void; onDeleted: (result: GatewayLogCleanupResult) => void }) {
  const [scope, setScope] = useState<GatewayLogCleanupScope>("both");
  const [vendorId, setVendorId] = useState("");
  const [outcome, setOutcome] = useState<GatewayLogCleanupOutcome>("");
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [appliedFilter, setAppliedFilter] = useState<GatewayLogCleanupFilter>(() => ({ scope: "both", ...resolveDateRange("30d", "", "") }));
  const [items, setItems] = useState<GatewayLogCleanupEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGINATION_DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const dateRange = useMemo(() => resolveDateRange(datePreset, customFrom, customTo), [datePreset, customFrom, customTo]);
  const vendorNames = useMemo(() => new Map(vendors.map((vendor) => [vendor.id, vendor.name])), [vendors]);
  const pageIds = useMemo(() => items.map((item) => item.id), [items]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.codexConsole.queryGatewayLogs(appliedFilter, page, pageSize);
      setItems(result.items);
      setTotal(result.total);
      setSelectedIds(new Set());
    } catch (cause: unknown) {
      setItems([]);
      setTotal(0);
      setError(captureError(cause, "gatewayLogCleanupQuery"));
    } finally {
      setLoading(false);
    }
  }, [appliedFilter, page, pageSize]);

  useEffect(() => { void refresh(); }, [refresh]);

  function applyQuery() {
    if (dateRange.error) {
      setError(dateRange.error);
      return;
    }
    setError("");
    setPage(1);
    setAppliedFilter({ scope, vendorId, outcome, periodStart: dateRange.periodStart, periodEnd: dateRange.periodEnd });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function togglePageSelection() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id)); else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function deleteSelected() {
    const selections: GatewayLogCleanupSelection[] = items.filter((item) => selectedIds.has(item.id)).map((item) => ({ id: item.id, source: item.source }));
    if (selections.length === 0) return;
    if (!window.confirm(`确认删除已勾选的 ${selections.length} 条 Gateway 日志记录吗？此操作无法恢复。`)) return;
    setDeleting(true);
    setError("");
    try {
      const result = await window.codexConsole.deleteGatewayLogEntries(selections);
      onDeleted(result);
      if (items.length === selections.length && page > 1) setPage((current) => current - 1); else await refresh();
    } catch (cause: unknown) {
      setError(captureError(cause, "gatewayLogCleanupDelete"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog title="清理 Gateway 日志" onClose={onClose} className="gateway-log-cleanup-dialog" busy={loading || deleting}>
      <div className="gateway-log-cleanup-form">
        <label className="session-path-field"><span>查询范围</span><select value={scope} onChange={(event) => setScope(event.target.value as GatewayLogCleanupScope)}><option value="both">文件日志和请求记录</option><option value="file">仅文件日志</option><option value="request">仅请求记录</option></select></label>
        <label className="session-path-field"><span>供应商</span><select value={vendorId} onChange={(event) => setVendorId(event.target.value)}><option value="">全部供应商</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
        <label className="session-path-field"><span>结果类型</span><select value={outcome} onChange={(event) => setOutcome(event.target.value as GatewayLogCleanupOutcome)}><option value="">全部结果</option><option value="ok">成功</option><option value="error">请求失败</option><option value="timeout">请求超时</option><option value="client-aborted">客户端中断</option></select></label>
        <label className="session-path-field"><span>时间范围</span><select value={datePreset} onChange={(event) => setDatePreset(event.target.value as DatePreset)}><option value="all">全部时间</option><option value="today">今天</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="custom">自定义</option></select></label>
        {datePreset === "custom" && <div className="gateway-log-cleanup-custom-dates"><label className="session-path-field"><span>开始日期</span><input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label className="session-path-field"><span>结束日期</span><input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></div>}
        <div className="gateway-log-cleanup-query-actions"><button type="button" className="ui-button ui-button-secondary" onClick={applyQuery} disabled={loading || deleting}><Search size={15} aria-hidden="true" />查询</button><IconButton icon={RefreshCw} label="刷新查询结果" onClick={() => void refresh()} disabled={loading || deleting} className={loading ? "is-spinning" : ""} /></div>
      </div>
      {dateRange.error && <p className="dialog-error">{dateRange.error}</p>}
      {error && <p className="dialog-error" role="status">{error}</p>}
      <div className="gateway-log-cleanup-toolbar"><label><input type="checkbox" checked={allPageSelected} onChange={togglePageSelection} disabled={loading || deleting || items.length === 0} /><span>全选当前页</span></label><span>已选择 {selectedIds.size} 条</span></div>
      <div className={`gateway-log-cleanup-table-wrap${loading ? " is-loading" : ""}`} aria-busy={loading}>
        {loading && items.length === 0 ? <p className="gateway-log-cleanup-empty">正在查询日志...</p> : items.length === 0 ? <p className="gateway-log-cleanup-empty">暂无符合条件的日志记录。</p> : <table className="gateway-log-cleanup-table"><thead><tr><th><span className="visually-hidden">选择</span></th><th>时间</th><th>来源</th><th>供应商</th><th>结果</th><th>详情</th><th>耗时</th></tr></thead><tbody>{items.map((item) => <CleanupRow key={`${item.source}:${item.id}`} item={item} vendorName={item.vendorId ? vendorNames.get(item.vendorId) || "已删除供应商" : "-"} selected={selectedIds.has(item.id)} onToggle={() => toggleSelected(item.id)} />)}</tbody></table>}
      </div>
      <Pagination total={total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} disabled={loading || deleting} label="Gateway 日志分页" />
      <footer><button type="button" className="ui-button ui-button-secondary" onClick={onClose} disabled={loading || deleting}>取消</button><button type="button" className="ui-button ui-button-danger" onClick={() => void deleteSelected()} disabled={loading || deleting || selectedIds.size === 0}><Trash2 size={15} aria-hidden="true" />{deleting ? "删除中..." : `删除已选 (${selectedIds.size})`}</button></footer>
    </Dialog>
  );
}

function CleanupRow({ item, vendorName, selected, onToggle }: { item: GatewayLogCleanupEntry; vendorName: string; selected: boolean; onToggle: () => void }) {
  const outcome = item.outcome ? formatOutcome(item.outcome) : item.level ? `${item.level} 事件` : "-";
  const detail = item.errorMessage || item.errorCode || item.event || item.path || "-";
  return <tr><td><input type="checkbox" checked={selected} onChange={onToggle} aria-label={`选择 ${item.createdAt} 的日志`} /></td><td>{formatCleanupTime(item.createdAt)}</td><td>{item.source === "file" ? `文件${item.fileName ? ` (${item.fileName})` : ""}` : "请求记录"}</td><td title={vendorName}>{vendorName}</td><td>{outcome}{item.upstreamStatus ? ` (${item.upstreamStatus})` : ""}</td><td className="gateway-log-cleanup-detail" title={detail}>{detail}</td><td>{formatCleanupDuration(item.durationMs)}</td></tr>;
}

function resolveDateRange(preset: DatePreset, from: string, to: string) {
  if (preset === "all") return { periodStart: "", periodEnd: "" };
  if (preset === "custom") {
    if (!from || !to) return { periodStart: "", periodEnd: "", error: "请选择完整的起止日期。" };
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T23:59:59.999`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return { periodStart: "", periodEnd: "", error: "开始日期不能晚于结束日期。" };
    return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
  }
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (preset === "7d") start.setDate(start.getDate() - 6);
  if (preset === "30d") start.setDate(start.getDate() - 29);
  return { periodStart: start.toISOString(), periodEnd: now.toISOString() };
}

function formatOutcome(outcome: GatewayLogCleanupOutcome) {
  return { ok: "成功", error: "请求失败", timeout: "请求超时", "client-aborted": "客户端中断", "": "-" }[outcome];
}

function formatCleanupTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function formatCleanupDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

export function formatGatewayCleanupResult(result: GatewayLogCleanupResult) {
  return `Gateway 日志已删除：文件记录 ${result.deletedFileEntries} 条，请求记录 ${result.deletedRequestEntries} 条，删除文件 ${result.deletedFiles} 个。`;
}
