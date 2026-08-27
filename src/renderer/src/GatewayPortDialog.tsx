import type { GatewayPortStatus } from "./types";
import { Dialog } from "./Dialog";

export function GatewayPortDialog({
  draft,
  status,
  error,
  busy,
  onChange,
  onClose,
  onSave
}: {
  draft: string;
  status: GatewayPortStatus | null;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      title="设置网关端口"
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
        当前监听端口：{status?.activePort ? status.activePort : "未启动"}。修改后仅对下次启动的 Gateway 生效。
      </p>
      {status && status.configuredPort !== 0 && status.activePort !== 0 && status.activePort !== status.configuredPort && (
        <p className="dialog-hint">
          配置端口 {status.configuredPort} 被占用，Gateway 已回退到 {status.activePort}；新建终端将使用回退端口。
        </p>
      )}
      {error && <p className="dialog-error">{error}</p>}
    </Dialog>
  );
}