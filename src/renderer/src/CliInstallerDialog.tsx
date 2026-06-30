import type { AiProviderId, AiTarget, CliEnvironmentStatus, CliInstallResult } from "./types";
import { CLI_INSTALLERS } from "../../shared/cliInstallers";

// “安装 CLI”弹框：按 AI 厂商展示当前目标环境的 Node/npm/nvm/CLI 状态并触发安装。
// 从 App.tsx 抽出为独立组件，连同其专用的 StatusLine / formatCliTargetScope 一起迁移。

export type CliInstallerState = AiProviderId | null;

export function CliInstallerDialog({
  busy,
  environments,
  environmentLoading,
  nodeMajor,
  result,
  error,
  target,
  onNodeMajorChange,
  onRefresh,
  onClose,
  onInstall
}: {
  busy: CliInstallerState;
  environments: Partial<Record<AiProviderId, CliEnvironmentStatus>>;
  environmentLoading: boolean;
  nodeMajor: number;
  result: CliInstallResult | null;
  error: string;
  target?: AiTarget;
  onNodeMajorChange: (nodeMajor: number) => void;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
  onInstall: (providerId: AiProviderId) => void | Promise<void>;
}) {
  const primaryEnvironment = CLI_INSTALLERS.map((installer) => environments[installer.providerId]).find(Boolean);
  const targetScope = primaryEnvironment ? formatCliTargetScope(primaryEnvironment) : environmentLoading ? "检测中..." : "未检测";
  return (
    <div className="dialog-overlay" role="presentation">
      <section className="cli-installer-dialog" role="dialog" aria-modal="true" aria-labelledby="cli-installer-title">
        <header>
          <div>
            <h2 id="cli-installer-title">安装 CLI</h2>
            <p>选择已集成的 AI 厂商，在当前目标环境执行 npm 全局安装。Node 缺失或版本不足时，会优先使用已安装的 nvm 安装 Node。</p>
          </div>
          <button type="button" title="关闭" onClick={onClose} disabled={Boolean(busy)}>
            x
          </button>
        </header>
        <div className="cli-installer-toolbar">
          <div className="cli-target-summary">
            <span>目标环境</span>
            <strong>{target?.label || "当前运行环境"}</strong>
            <small>{targetScope}</small>
          </div>
          <label>
            <span>Node 版本</span>
            <select value={nodeMajor} onChange={(event) => onNodeMajorChange(Number(event.target.value))} disabled={Boolean(busy)}>
              <option value={24}>24 LTS 推荐</option>
              <option value={22}>22 LTS 兼容</option>
            </select>
          </label>
          <button type="button" className="secondary" onClick={() => void onRefresh()} disabled={Boolean(busy) || environmentLoading}>
            {environmentLoading ? "检测中..." : "重新检测"}
          </button>
        </div>
        <div className="cli-installer-grid">
          {CLI_INSTALLERS.map((installer) => {
            const environment = environments[installer.providerId];
            const installing = busy === installer.providerId;
            const disabled = Boolean(busy);
            const needsNode = Boolean(environment && !environment.canInstallCli);
            const blockedByNvm = Boolean(needsNode && !environment?.canInstallNodeWithNvm);
            const canInstall = Boolean(environment && (environment.canInstallCli || environment.canInstallNodeWithNvm));
            return (
              <article key={installer.providerId} className="cli-installer-card">
                <div className={`cli-installer-icon provider-${installer.providerId}`} aria-hidden="true">
                  {installer.iconLabel}
                </div>
                <div className="cli-installer-main">
                  <h3>{installer.label}</h3>
                  <p>{installer.description}</p>
                  <div className="cli-installer-status">
                    <StatusLine label="官方 Node" value={environment ? `${environment.minimumNodeMajor}+` : "-"} ok={true} />
                    <StatusLine label="Node" value={environment?.nodeVersion || "未检测到"} ok={environment?.nodeMeetsMinimum} />
                    <StatusLine label="npm" value={environment?.npmVersion || "未检测到"} ok={environment?.hasNpm} />
                    <StatusLine label="nvm" value={environment?.nvmVersion || "未检测到"} ok={environment?.hasNvm} />
                    <StatusLine label="CLI" value={environment?.cliVersion || "未安装"} ok={environment?.hasCli} />
                  </div>
                  {environment?.messages.length ? (
                    <p className="cli-installer-message">{environment.messages.join(" ")}</p>
                  ) : null}
                </div>
                <div className="cli-installer-actions">
                  <button
                    type="button"
                    disabled={disabled || environmentLoading || !canInstall}
                    title={blockedByNvm ? "请先安装 nvm 后重新检测" : undefined}
                    onClick={() => void onInstall(installer.providerId)}
                  >
                    {installing ? "安装中..." : needsNode ? `安装 Node ${nodeMajor} 并安装 CLI` : "安装"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {(busy || result || error) && (
          <section className="cli-installer-output" aria-live="polite">
            {busy && <strong>正在安装 CLI...</strong>}
            {result && (
              <>
                <strong>执行完成</strong>
                <pre>{[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n") || "npm 未返回输出。"}</pre>
              </>
            )}
            {error && (
              <>
                <strong>执行失败</strong>
                <pre>{error}</pre>
              </>
            )}
          </section>
        )}
        <footer>
          <button type="button" className="secondary" onClick={onClose} disabled={Boolean(busy)}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={ok ? "ok" : "missing"} title={value}>
        {value}
      </strong>
    </div>
  );
}

function formatCliTargetScope(environment: CliEnvironmentStatus) {
  const scope = environment.scope === "wsl" ? "WSL" : "本机";
  return `${scope}（${environment.platform}）`;
}
