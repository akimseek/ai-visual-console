import type { GatewayExternalApiStatus, GatewayPortStatus } from "../../types";
import { Dialog } from "../../components/dialog";
import { Copy, KeyRound, RefreshCw } from "lucide-react";

export function GatewayPortDialog({
  draft,
  failureThresholdDraft,
  circuitFailureThresholdDraft,
  circuitDurationDraft,
  status,
  externalApiStatus,
  externalApiToken,
  error,
  busy,
  onChange,
  onFailureThresholdChange,
  onCircuitFailureThresholdChange,
  onCircuitDurationChange,
  onSetEnabled,
  onSetExternalApiEnabled,
  onRotateExternalApiToken,
  onCopyExternalApiToken,
  onClose,
  onSave
}: {
  draft: string;
  failureThresholdDraft: string;
  circuitFailureThresholdDraft: string;
  circuitDurationDraft: string;
  status: GatewayPortStatus | null;
  externalApiStatus: GatewayExternalApiStatus | null;
  externalApiToken: string;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onFailureThresholdChange: (value: string) => void;
  onCircuitFailureThresholdChange: (value: string) => void;
  onCircuitDurationChange: (value: string) => void;
  onSetEnabled: (enabled: boolean) => void;
  onSetExternalApiEnabled: (enabled: boolean) => void;
  onRotateExternalApiToken: () => void;
  onCopyExternalApiToken: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      title="网关"
      onClose={onClose}
      className="gateway-settings-dialog"
      busy={busy}
      footer={
        <>
          <button type="button" className="ui-button ui-button-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="ui-button ui-button-primary" onClick={onSave} disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        </>
      }
    >
      <div className="gateway-settings-content">
        <label className="gateway-enabled-toggle">
          <span>
            <strong>开启本地网关</strong>
            <small>关闭后，使用网关的终端路由将立即停止。</small>
          </span>
          <input
            type="checkbox"
            checked={status?.enabled ?? true}
            disabled={busy || !status}
            onChange={(event) => onSetEnabled(event.target.checked)}
          />
        </label>
        <section className="gateway-external-api">
          <div className="gateway-external-api-heading">
            <div>
              <strong>外部 API 接入</strong>
              <small>供本机其他客户端调用；请求按路径选择平台，并由 Gateway 使用该平台供应商池。</small>
            </div>
            <label className="gateway-external-api-switch" title={!status?.enabled ? "请先开启本地 Gateway" : !externalApiStatus?.tokenConfigured ? "请先生成访问令牌" : undefined}>
              <input
                type="checkbox"
                checked={externalApiStatus?.enabled ?? false}
                disabled={busy || !status?.enabled || !externalApiStatus?.tokenConfigured}
                onChange={(event) => onSetExternalApiEnabled(event.target.checked)}
              />
              <span>启用</span>
            </label>
          </div>
          <p className="dialog-hint">
            {externalApiStatus?.enabled ? "外部 API 已启用" : "外部 API 默认关闭"}；仅监听 127.0.0.1，不接受局域网连接。
          </p>
          <div className="gateway-external-token-row">
            <div>
              <strong>共享访问令牌</strong>
              <small>{externalApiToken ? "令牌只在本次显示，关闭此窗口后无法再次查看。" : externalApiStatus?.tokenConfigured ? "已配置；轮换后旧令牌立即失效。" : "尚未生成访问令牌。"}</small>
            </div>
            <button type="button" className="ui-button ui-button-secondary" onClick={onRotateExternalApiToken} disabled={busy}>
              {externalApiStatus?.tokenConfigured ? <RefreshCw aria-hidden="true" size={14} /> : <KeyRound aria-hidden="true" size={14} />}
              {externalApiStatus?.tokenConfigured ? "轮换令牌" : "生成令牌"}
            </button>
          </div>
          {externalApiToken && (
            <div className="gateway-external-token-value">
              <code>{externalApiToken}</code>
              <button type="button" className="ui-button ui-button-secondary" onClick={onCopyExternalApiToken} disabled={busy}>
                <Copy aria-hidden="true" size={14} />复制
              </button>
            </div>
          )}
          <div className="gateway-external-endpoints">
            <strong>平台 Base URL</strong>
            {status?.activePort ? (
              <dl>
                <div><dt>Codex</dt><dd><code>http://127.0.0.1:{status.activePort}/external/codex/v1</code></dd></div>
                <div><dt>Claude</dt><dd><code>http://127.0.0.1:{status.activePort}/external/claude</code></dd></div>
                <div><dt>Gemini</dt><dd><code>http://127.0.0.1:{status.activePort}/external/gemini</code></dd></div>
                <div><dt>Qoder</dt><dd><code>http://127.0.0.1:{status.activePort}/external/qoder/v1</code></dd></div>
              </dl>
            ) : <small>本地 Gateway 正在监听后显示可用地址。</small>}
          </div>
          <small className="gateway-external-auth-hint">Codex/Qoder 使用 Bearer，Claude 使用 x-api-key，Gemini 使用 x-goog-api-key 或 key 查询参数；四者使用同一令牌。</small>
        </section>
        <p className="dialog-hint">
          网关状态：{status?.enabled ? status.activePort ? "运行中" : "未运行" : "已关闭"}；当前监听端口：{status?.activePort || "未监听"}。
        </p>
        <label className="session-path-field">
        <span>监听端口（0 表示自动分配）</span>
        <input
          type="number"
          min="0"
          max="65535"
          step="1"
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
        />
        </label>
        <p className="dialog-hint">
          当前监听端口：{status?.activePort ? status.activePort : "未启动"}。端口修改后对下次启动的 Gateway 生效。
        </p>
        <label className="session-path-field">
        <span>异常切换阈值（次）</span>
        <input
          type="number"
          min="1"
          max="10"
          step="1"
          value={failureThresholdDraft}
          onChange={(event) => onFailureThresholdChange(event.target.value)}
        />
        </label>
        <p className="dialog-hint">同一供应商连续请求失败达到该次数后，才切换到候选池中的下一个供应商。</p>
        <label className="session-path-field">
        <span>熔断次数</span>
        <input
          type="number"
          min="1"
          max="20"
          step="1"
          value={circuitFailureThresholdDraft}
          onChange={(event) => onCircuitFailureThresholdChange(event.target.value)}
        />
        </label>
        <p className="dialog-hint">供应商在该时间窗口内累计失败达到次数后进入熔断状态。</p>
        <label className="session-path-field">
        <span>熔断持续时间（秒）</span>
        <input
          type="number"
          min="10"
          max="86400"
          step="1"
          value={circuitDurationDraft}
          onChange={(event) => onCircuitDurationChange(event.target.value)}
        />
        </label>
        <p className="dialog-hint">熔断期间不会选择该供应商；到期后进入半开状态并允许一次试探请求。</p>
        {status && status.configuredPort !== 0 && status.activePort !== 0 && status.activePort !== status.configuredPort && (
          <p className="dialog-hint">
            配置端口 {status.configuredPort} 被占用，Gateway 已回退到 {status.activePort}；新建终端将使用回退端口。
          </p>
        )}
        {error && <p className="dialog-error">{error}</p>}
      </div>
    </Dialog>
  );
}
