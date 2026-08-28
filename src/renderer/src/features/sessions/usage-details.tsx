import type { AiSession } from "../../types";
import { formatDate } from "../../lib/format";
import { buildTokenRows, formatFullNumber, formatPercent, usageSourceLabel } from "./session-format";

// 底部状态栏的 Token / 上下文详情浮层，从 App.tsx 抽出为独立展示组件。

export function UsageDetailsPopover({ session }: { session?: AiSession | null }) {
  const usage = session?.usage;
  const totalRows = buildTokenRows(usage?.total);
  const lastRows = buildTokenRows(usage?.last);
  const contextRows = [
    { label: "已用", value: formatFullNumber(usage?.contextUsedTokens) },
    { label: "窗口", value: formatFullNumber(usage?.contextWindow) },
    { label: "已用比例", value: formatPercent(usage?.contextPercent) },
    { label: "剩余比例", value: formatPercent(usage?.contextLeftPercent) }
  ];

  return (
    <section className="usage-popover" role="dialog" aria-label="Token 和上下文详情">
      <header>
        <h2>Token / 上下文</h2>
        <span>{usageSourceLabel(usage?.source)}</span>
      </header>
      <div className="usage-popover-grid">
        <UsageDetailSection title="总计" rows={totalRows} />
        <UsageDetailSection title="最近一轮" rows={lastRows} />
        <UsageDetailSection title="上下文" rows={contextRows} />
      </div>
      <footer>
        <span>更新时间</span>
        <strong>{usage?.updatedAt ? formatDate(usage.updatedAt) : "-"}</strong>
      </footer>
    </section>
  );
}

function UsageDetailSection({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="usage-detail-section">
      <h3>{title}</h3>
      <dl>
        {rows.map((row) => (
          <div key={`${title}:${row.label}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
