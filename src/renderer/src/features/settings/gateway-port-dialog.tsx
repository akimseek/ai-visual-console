import type { GatewayPortStatus } from "../../types";
import { Dialog } from "../../components/dialog";

export function GatewayPortDialog({
  draft,
  failureThresholdDraft,
  circuitFailureThresholdDraft,
  circuitDurationDraft,
  status,
  error,
  busy,
  onChange,
  onFailureThresholdChange,
  onCircuitFailureThresholdChange,
  onCircuitDurationChange,
  onClose,
  onSave
}: {
  draft: string;
  failureThresholdDraft: string;
  circuitFailureThresholdDraft: string;
  circuitDurationDraft: string;
  status: GatewayPortStatus | null;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onFailureThresholdChange: (value: string) => void;
  onCircuitFailureThresholdChange: (value: string) => void;
  onCircuitDurationChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      title="设置"
      onClose={onClose}
      className="session-settings-dialog"
      busy={busy}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" onClick={onSave} disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        </>
      }
    >
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
    </Dialog>
  );
}
