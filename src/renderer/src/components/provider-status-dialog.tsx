import { useEffect, useState } from "react";
import type { AiProviderId, AiProviderSummary, AiTarget } from "../types";
import { Dialog } from "./dialog";

// 平台状态弹框：集中展示当前 Provider 的目标、路径、命令与能力，并对可打开路径做存在性探测。
// 从 App.tsx 抽出为独立组件，连同其专用的纯函数一起迁移。

type ProviderPathRow = {
  label: string;
  value: string;
  path: string;
  openable: boolean;
};
type ProviderStatusLevel = "ok" | "missing" | "checking" | "unknown";
type ProviderStatusRow = {
  label: string;
  value: string;
  path?: string;
  openable?: boolean;
  status?: ProviderStatusLevel;
};

export function ProviderStatusDialog({
  provider,
  target,
  targetCount,
  onClose,
  onRescan,
  onRefresh
}: {
  provider?: AiProviderSummary;
  target?: AiTarget;
  targetCount: number;
  onClose: () => void;
  onRescan: () => void;
  onRefresh: () => void;
}) {
  const [pathStatuses, setPathStatuses] = useState<Record<string, ProviderStatusLevel>>({});
  const openPath = (nextTargetId: string | undefined, path: string) => {
    void window.codexConsole.openPath({ targetId: nextTargetId, path });
  };
  const copyPath = (path: string) => {
    void window.codexConsole.copyText(path);
  };

  const pathRows = buildProviderPathRows(provider?.id, target);
  const commandRows = buildProviderCommandRows(provider?.id);
  const capabilityRows = buildProviderCapabilityRows(provider?.capabilities);
  const platformRows: ProviderStatusRow[] = [
    { label: "平台", value: provider?.label || "-" },
    { label: "Provider ID", value: provider?.id || "-" },
    { label: "目标数量", value: `${targetCount}` },
    { label: "当前目标", value: target?.label || "-" },
    { label: "目标 ID", value: target?.id || "-" },
    { label: "目标类型", value: target?.kind === "wsl" ? `WSL${target.distro ? ` / ${target.distro}` : ""}` : target?.kind || "-" },
    {
      label: "命令状态",
      value: target ? (target.available ? "可用" : "未找到命令") : "-",
      status: target ? (target.available ? "ok" : "missing") : "unknown"
    },
    { label: "探测结果", value: target?.detail || "-" }
  ];
  const checkedPathRows = pathRows.map((row) => ({
    ...row,
    status: row.openable ? pathStatuses[row.path] || "checking" : "unknown"
  }));

  useEffect(() => {
    let cancelled = false;
    const rows = pathRows.filter((row) => row.openable);
    setPathStatuses(Object.fromEntries(rows.map((row) => [row.path, "checking" as ProviderStatusLevel])));
    void Promise.all(
      rows.map(async (row) => {
        const exists = await window.codexConsole.pathExists({ targetId: target?.id, path: row.path }).catch(() => false);
        return [row.path, exists ? "ok" : "missing"] as const;
      })
    ).then((entries) => {
      if (!cancelled) setPathStatuses(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
    // pathRows 由 provider/target 派生，依赖其原始字段即可，避免每帧新数组触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, provider?.id, target?.codexHome]);

  return (
    <Dialog
      title="平台状态"
      onClose={onClose}
      className="provider-status-dialog"
      closeOnOverlay={false}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="secondary" onClick={onRescan} disabled={!provider}>
            重新探测目标
          </button>
          <button type="button" onClick={onRefresh} disabled={!provider}>
            刷新
          </button>
        </>
      }
    >
      <div className="provider-status-content">
        <ProviderStatusSection title="目标" rows={platformRows} />
        <ProviderStatusSection
          title="路径"
          rows={checkedPathRows}
          targetId={target?.id}
          onOpenPath={openPath}
          onCopyPath={copyPath}
        />
        <ProviderStatusSection title="命令" rows={commandRows} />
        <section className="provider-status-section">
          <h3>能力</h3>
          <div className="capability-grid">
            {capabilityRows.map((row) => (
              <span key={row.label} className={row.enabled ? "enabled" : ""}>
                {row.label}
              </span>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function ProviderStatusSection({
  title,
  rows,
  targetId,
  onOpenPath,
  onCopyPath
}: {
  title: string;
  rows: ProviderStatusRow[];
  targetId?: string;
  onOpenPath?: (targetId: string | undefined, path: string) => void;
  onCopyPath?: (path: string) => void;
}) {
  return (
    <section className="provider-status-section">
      <h3>{title}</h3>
      <dl>
        {rows.map((row) => (
          <div key={`${title}:${row.label}`}>
            <dt>{row.label}</dt>
            <dd title={row.value}>
              <span className="provider-status-value">
                {row.status && <span className={`provider-status-dot ${row.status}`} title={providerStatusLabel(row.status)} />}
                <span>{row.value}</span>
              </span>
              {(() => {
                const path = row.path;
                if (!row.openable || !path) return null;
                return (
                <span className="provider-status-row-actions">
                  <button type="button" disabled={!row.openable} onClick={() => onOpenPath?.(targetId, path)}>
                    打开
                  </button>
                  <button type="button" onClick={() => onCopyPath?.(path)}>
                    复制
                  </button>
                </span>
                );
              })()}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function buildProviderPathRows(providerId?: AiProviderId, target?: AiTarget): ProviderPathRow[] {
  const home = target?.codexHome || providerDefaultHome(providerId);
  const openable = Boolean(target?.id);
  if (providerId === "gemini") {
    return [
      { label: "配置目录", value: home, path: home, openable },
      { label: "历史目录", value: joinDisplayPath(home, "tmp"), path: joinDisplayPath(home, "tmp"), openable },
      { label: "回收站", value: joinDisplayPath(home, ".visual-console-trash/tmp"), path: joinDisplayPath(home, ".visual-console-trash/tmp"), openable }
    ];
  }
  if (providerId === "claude") {
    return [
      { label: "配置目录", value: home, path: home, openable },
      { label: "历史目录", value: joinDisplayPath(home, "projects"), path: joinDisplayPath(home, "projects"), openable },
      { label: "回收站", value: joinDisplayPath(home, ".visual-console-trash/projects"), path: joinDisplayPath(home, ".visual-console-trash/projects"), openable },
      { label: "Telemetry", value: joinDisplayPath(home, "telemetry"), path: joinDisplayPath(home, "telemetry"), openable }
    ];
  }
  if (providerId === "qoder") {
    return [
      { label: "配置目录", value: home, path: home, openable },
      { label: "历史目录", value: joinDisplayPath(home, "projects"), path: joinDisplayPath(home, "projects"), openable }
    ];
  }
  return [
    { label: "配置目录", value: home, path: home, openable },
    { label: "历史目录", value: joinDisplayPath(home, "sessions"), path: joinDisplayPath(home, "sessions"), openable },
    { label: "回收站", value: joinDisplayPath(home, ".visual-console-trash/sessions"), path: joinDisplayPath(home, ".visual-console-trash/sessions"), openable }
  ];
}

function buildProviderCommandRows(providerId?: AiProviderId): ProviderStatusRow[] {
  if (providerId === "gemini") {
    return [
      { label: "新会话", value: "gemini" },
      { label: "继续会话", value: "gemini --resume <sessionId>" }
    ];
  }
  if (providerId === "claude") {
    return [
      { label: "新会话", value: "claude" },
      { label: "继续会话", value: "claude --resume <sessionId>" }
    ];
  }
  if (providerId === "qoder") {
    return [
      { label: "新会话", value: "qodercn" },
      { label: "继续会话", value: "qodercn --resume <sessionId>" }
    ];
  }
  return [
    { label: "新会话", value: "codex" },
    { label: "指定目录", value: "codex -C <path>" },
    { label: "继续会话", value: "codex resume <sessionId>" }
  ];
}

function buildProviderCapabilityRows(capabilities?: AiProviderSummary["capabilities"]) {
  return [
    { label: "Skill", enabled: Boolean(capabilities?.skills) },
    { label: "分支", enabled: Boolean(capabilities?.branch) },
    { label: "Usage", enabled: Boolean(capabilities?.usage) },
    { label: "回收站", enabled: Boolean(capabilities?.trash) },
    { label: "批量", enabled: Boolean(capabilities?.batchActions) },
    { label: "工作目录", enabled: Boolean(capabilities?.customCwd) },
    { label: "导出", enabled: Boolean(capabilities?.export) },
    { label: "会话设置", enabled: Boolean(capabilities?.sessionSettings) },
    { label: "复制", enabled: Boolean(capabilities?.duplicate) },
    { label: "供应商管理", enabled: Boolean(capabilities?.vendorManagement) }
  ];
}

function providerStatusLabel(status: ProviderStatusLevel) {
  if (status === "ok") return "正常";
  if (status === "missing") return "缺失";
  if (status === "checking") return "检查中";
  return "未知";
}

function providerDefaultHome(providerId?: AiProviderId) {
  if (providerId === "gemini") return "~/.gemini";
  if (providerId === "claude") return "~/.claude";
  if (providerId === "qoder") return "~/.qoder-cn";
  return "~/.codex";
}

function joinDisplayPath(base: string, child: string) {
  const separator = base.includes("\\") ? "\\" : "/";
  const normalizedBase = base.replace(/[\\/]+$/, "");
  const normalizedChild = child.replace(/[\\/]+/g, separator);
  return `${normalizedBase}${separator}${normalizedChild}`;
}
