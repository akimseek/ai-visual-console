import { Activity, CheckCircle2, ChevronRight, CircleAlert, Clock3, Database, Gauge, LayoutDashboard, MessagesSquare, RefreshCw, Server, TriangleAlert, Waypoints } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AiProviderSummary, AiSession, AiTarget, ApiVendor, GatewayRecentFailure, GatewayUsageSummary, GatewayVendorHealth } from "../../types";
import { IconButton } from "../../components/icon-button";
import { useWorkbenchHealth } from "./use-workbench-health";
import { formatGatewayFailure, formatGatewayUsageSummary, useWorkbenchUsage } from "./use-workbench-usage";
import type { TabVendorSwitch } from "../vendors/use-tab-vendors";
import { GatewayFailureDialog } from "./gateway-failure-dialog";
import { useVendorData } from "../vendors/vendor-context";

type StatusText = { label: string; title: string };

// 侧栏工作台只聚合当前运行摘要，不展示候选池，更不承担供应商切换或余额查询业务。
export function SidebarWorkbench({
  provider,
  target,
  activeVendorId,
  activeVendorName,
  lastVendorSwitch,
  session,
  model,
  tokenUsage,
  contextUsage
}: {
  provider: AiProviderSummary | undefined;
  target: AiTarget | undefined;
  activeVendorId: string | undefined;
  activeVendorName: string;
  lastVendorSwitch: TabVendorSwitch | undefined;
  session: AiSession | null;
  model: StatusText;
  tokenUsage: StatusText;
  contextUsage: StatusText;
}) {
  const vendors = useVendorData();
  const { health, loading: healthLoading, error: healthError, lastUpdatedAt: healthUpdatedAt, refresh: refreshHealth } = useWorkbenchHealth();
  const { summary: usageSummary, recentFailures, loading: usageLoading, error: usageError, lastUpdatedAt: usageUpdatedAt, refresh: refreshUsage } = useWorkbenchUsage();
  const [failureDialogOpen, setFailureDialogOpen] = useState(false);
  const healthByVendorId = new Map(health.map((item) => [item.vendorId, item]));
  const activeVendor = activeVendorId ? vendors.find((vendor) => vendor.id === activeVendorId) : undefined;
  const activeHealth = activeVendorId ? healthByVendorId.get(activeVendorId) || activeVendor?.gatewayHealth : undefined;
  const rateLimitWindows = getRateLimitWindows(session);
  const refreshing = healthLoading || usageLoading;
  const lastRefreshedAt = getLastCompleteWorkbenchRefresh(healthUpdatedAt, usageUpdatedAt);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.codexConsole.onGatewayRequestRecorded(() => {
      // 多个并发请求可能在同一时间完成，合并短时间内的刷新，避免工作台反复读取数据库。
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void Promise.all([refreshHealth(), refreshUsage()]);
      }, 250);
    });
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [refreshHealth, refreshUsage]);

  return (
    <section className="sidebar-workbench" aria-label="工作台">
      <header className="sidebar-workbench-header">
        <div className="sidebar-workbench-heading">
          <LayoutDashboard aria-hidden="true" size={20} strokeWidth={1.8} />
          <div>
            <h2>工作台</h2>
            <p>当前会话与 Gateway 运行概览</p>
          </div>
        </div>
        <div className="sidebar-workbench-refresh">
          <span title={lastRefreshedAt ? `上次完整刷新：${formatWorkbenchRefreshClock(lastRefreshedAt)}` : "等待健康与用量数据完成首次读取"}>
            {formatWorkbenchRefreshTime(lastRefreshedAt, refreshing)}
          </span>
          <IconButton
            icon={RefreshCw}
            label="刷新工作台数据"
            className={refreshing ? "is-spinning" : ""}
            disabled={refreshing}
            onClick={() => void Promise.all([refreshHealth(), refreshUsage()])}
          />
        </div>
      </header>

      <div className="sidebar-workbench-scroll-area">
        <div className="sidebar-workbench-metrics">
          <MetricCard icon={Server} label="运行目标" value={provider?.label || "未选择平台"} detail={target?.label || "请选择一个目标"} />
          <MetricCard icon={Activity} label="当前供应商" value={activeVendorName || "尚未建立路由"} detail={<HealthState health={activeHealth} />} />
          <MetricCard icon={MessagesSquare} label="当前会话" value={session?.title || "未打开会话"} detail={session ? `模型：${model.label}` : "打开会话后显示模型信息"} />
          <MetricCard icon={Database} label="会话用量" value={tokenUsage.label} valueTitle={tokenUsage.title} detail={`上下文：${contextUsage.label}`} detailTitle={contextUsage.title} numeric />
          {lastVendorSwitch && <VendorSwitchCard vendors={vendors} value={lastVendorSwitch} />}
          {rateLimitWindows.length > 0 && <RateLimitCard windows={rateLimitWindows} />}
          <GatewayUsageCard summary={usageSummary} />
          {recentFailures.length > 0 && <GatewayFailureCard vendors={vendors} failures={recentFailures} onOpenDetails={() => setFailureDialogOpen(true)} />}
        </div>

        {healthError && <p className="sidebar-workbench-error" role="status">{healthError}</p>}
        {usageError && <p className="sidebar-workbench-error" role="status">{usageError}</p>}
      </div>
      {failureDialogOpen && <GatewayFailureDialog onClose={() => setFailureDialogOpen(false)} />}
    </section>
  );
}

// “完整刷新”要求健康、用量两类数据均至少成功读取一次，较早时间是整组数据的实际新鲜度下界。
export function getLastCompleteWorkbenchRefresh(healthUpdatedAt: Date | null, usageUpdatedAt: Date | null) {
  if (!healthUpdatedAt || !usageUpdatedAt) return null;
  return new Date(Math.min(healthUpdatedAt.getTime(), usageUpdatedAt.getTime()));
}

export function formatWorkbenchRefreshTime(value: Date | null, refreshing: boolean) {
  if (refreshing && !value) return "正在更新";
  if (!value) return "等待数据";
  return `更新 ${formatWorkbenchRefreshClock(value)}`;
}

function formatWorkbenchRefreshClock(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
}

function GatewayFailureCard({ vendors, failures, onOpenDetails }: { vendors: ApiVendor[]; failures: GatewayRecentFailure[]; onOpenDetails: () => void }) {
  return (
    <article className="sidebar-workbench-metric sidebar-workbench-failures" aria-label="最近 Gateway 异常">
      <span className="sidebar-workbench-metric-icon"><TriangleAlert aria-hidden="true" size={17} strokeWidth={1.9} /></span>
      <div>
        <span>最近 Gateway 异常</span>
        <ul className="sidebar-gateway-failure-list">
          {failures.map((failure, index) => (
            <li key={`${failure.vendorId}-${failure.createdAt}-${index}`}>
              <strong>{formatGatewayFailure(failure)}</strong>
              <small>{formatFailureDetail(failure, vendors)}</small>
            </li>
          ))}
        </ul>
        <button type="button" className="sidebar-workbench-detail-link" onClick={onOpenDetails}>
          查看详情
          <ChevronRight aria-hidden="true" size={14} strokeWidth={2} />
        </button>
      </div>
    </article>
  );
}

// 失败摘要与供应商列表在不同 IPC 中读取，供应商被删除时仍要保持日志条目可读。
export function formatFailureDetail(failure: GatewayRecentFailure, vendors: ApiVendor[]) {
  const time = new Date(failure.createdAt);
  const timeText = Number.isNaN(time.getTime())
    ? "时间未知"
    : `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
  const vendorName = vendors.find((vendor) => vendor.id === failure.vendorId)?.name || "已删除供应商";
  return `${timeText} · ${vendorName}`;
}

// 仅显示当前标签收到的最近一次 Gateway 路由事件，不从候选池推断，也不跨标签混用。
export function formatVendorSwitch(value: TabVendorSwitch, vendorName: string) {
  const time = new Date(value.switchedAt);
  const timeText = Number.isNaN(time.getTime())
    ? "刚刚"
    : `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
  const reason = value.reason === "failure" ? "故障切换" : value.reason === "manual" ? "手动切换" : "路由调整";
  return { reason, detail: `${timeText} · ${vendorName || "供应商信息加载中"}` };
}

function VendorSwitchCard({ vendors, value }: { vendors: ApiVendor[]; value: TabVendorSwitch }) {
  const vendorName = vendors.find((vendor) => vendor.id === value.vendorId)?.name || "";
  const formatted = formatVendorSwitch(value, vendorName);
  return <MetricCard icon={Waypoints} label="最近路由变更" value={formatted.reason} detail={formatted.detail} className="sidebar-workbench-vendor-switch" />;
}

function GatewayUsageCard({ summary }: { summary: GatewayUsageSummary | null }) {
  const metrics = summary ? formatGatewayUsageSummary(summary) : null;
  return (
    <article className="sidebar-workbench-metric sidebar-workbench-gateway-usage" aria-label="今日 Gateway 用量">
      <span className="sidebar-workbench-metric-icon"><Activity aria-hidden="true" size={17} strokeWidth={1.9} /></span>
      <div>
        <span>今日 Gateway 用量</span>
        <dl className="sidebar-gateway-usage-grid">
          <UsageMetric label="请求" value={metrics?.requestCount || "加载中"} />
          <UsageMetric label="成功率" value={metrics?.successRate || "-"} />
          <UsageMetric label="故障切换" value={metrics?.switchedCount || "-"} />
          <UsageMetric label="Token / 费用" value={metrics ? `${metrics.totalTokens} / ${metrics.cost}` : "-"} />
        </dl>
      </div>
    </article>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

type RateLimitWindow = {
  label: string;
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
};

// 仅保留 Provider 已写入会话摘要的窗口，工作台不为获取限额额外请求 CLI 或 Gateway。
export function getRateLimitWindows(session?: AiSession | null): RateLimitWindow[] {
  const rateLimits = session?.usage?.rateLimits;
  const candidates: Array<RateLimitWindow | undefined> = [
    rateLimits?.primary && { label: "主窗口", ...rateLimits.primary },
    rateLimits?.secondary && { label: "次窗口", ...rateLimits.secondary }
  ];
  return candidates.filter((item): item is RateLimitWindow => Boolean(item));
}

function RateLimitCard({ windows }: { windows: RateLimitWindow[] }) {
  return (
    <article className="sidebar-workbench-metric sidebar-workbench-rate-limit" aria-label="速率限制">
      <span className="sidebar-workbench-metric-icon"><Gauge aria-hidden="true" size={17} strokeWidth={1.9} /></span>
      <div>
        <span>速率限制</span>
        <dl className="sidebar-rate-limit-windows">
          {windows.map((window) => (
            <div key={window.label}>
              <dt>{window.label}</dt>
              <dd>{typeof window.usedPercent === "number" ? `${window.usedPercent}%` : "-"}</dd>
              <small>{formatRateLimitDetail(window)}</small>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

function formatRateLimitDetail(window: RateLimitWindow) {
  const windowText = typeof window.windowMinutes === "number" ? `${window.windowMinutes} 分钟窗口` : "窗口长度未知";
  if (!window.resetsAt) return windowText;
  const resetAt = new Date(window.resetsAt);
  if (Number.isNaN(resetAt.getTime())) return windowText;
  return `${windowText}，${String(resetAt.getHours()).padStart(2, "0")}:${String(resetAt.getMinutes()).padStart(2, "0")} 重置`;
}

function MetricCard({
  icon: Icon,
  label,
  value,
  valueTitle,
  detail,
  detailTitle,
  numeric = false,
  className = ""
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  valueTitle?: string;
  detail: ReactNode;
  detailTitle?: string;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <article className={`sidebar-workbench-metric ${numeric ? "is-numeric" : ""} ${className}`.trim()} aria-label={label}>
      <span className="sidebar-workbench-metric-icon"><Icon aria-hidden="true" size={17} strokeWidth={1.9} /></span>
      <div>
        <span>{label}</span>
        <strong title={valueTitle || value}>{value}</strong>
        {typeof detail === "string" ? <small title={detailTitle || detail}>{detail}</small> : detail}
      </div>
    </article>
  );
}

function HealthState({ health }: { health: GatewayVendorHealth | undefined }) {
  const status = health?.status;
  if (!status) return <small>等待终端路由状态</small>;
  const detail = formatGatewayHealthDetail(health);

  return (
    <small className={`sidebar-workbench-health ${status}`} title={health.lastFailureReason}>
      {status === "open" ? <CircleAlert aria-hidden="true" size={14} /> : status === "healthy" ? <CheckCircle2 aria-hidden="true" size={14} /> : <Clock3 aria-hidden="true" size={14} />}
      <span>Gateway：{healthLabel(status)}</span>
      {detail && <span className="sidebar-workbench-health-detail">{detail}</span>}
    </small>
  );
}

// 熔断剩余时间只由当前渲染时刻计算；工作台不会为倒计时建立后台轮询。
export function formatGatewayHealthDetail(health: Pick<GatewayVendorHealth, "status" | "lastFailureAt" | "circuitUntil">, now = new Date()) {
  const lastFailureText = health.lastFailureAt ? formatHealthTime(health.lastFailureAt) : "";
  if (health.status === "open") {
    const circuitUntil = health.circuitUntil ? new Date(health.circuitUntil) : null;
    if (circuitUntil && !Number.isNaN(circuitUntil.getTime())) {
      const remainingMs = circuitUntil.getTime() - now.getTime();
      if (remainingMs > 0) return `熔断剩余 ${formatRemainingDuration(remainingMs)}`;
    }
    return "等待下次请求探测";
  }
  return lastFailureText ? `最近失败 ${lastFailureText}` : "";
}

function formatHealthTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "时间未知";
  return `${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")} ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

function formatRemainingDuration(remainingMs: number) {
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

function healthLabel(status: GatewayVendorHealth["status"]) {
  if (status === "open") return "已熔断";
  if (status === "half-open") return "探测中";
  if (status === "degraded") return "降级";
  return "健康";
}
