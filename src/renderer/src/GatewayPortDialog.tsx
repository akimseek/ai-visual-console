import type { GatewayPortStatus } from "./types";

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
    <div className="dialog-overlay" role="presentation">
      <section className="session-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="gateway-port-title">
        <header>
          <h2 id="gateway-port-title">设置网关端口</h2>
          <button type="button" title="关闭" onClick={onClose}>x</button>
        </header>
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
        {error && <p className="dialog-error">{error}</p>}
        <footer>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" onClick={onSave} disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        </footer>
      </section>
    </div>
  );
}
