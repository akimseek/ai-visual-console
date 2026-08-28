import { Dialog } from "../../components/dialog";

// 手动设置会话目录的弹框（仅 WSL 目标可用），从 App.tsx 的内联 JSX 抽出为展示组件。
export function SessionSettingsDialog({
  wslPath,
  isWsl,
  supportsSessionSettings,
  onChange,
  onClose,
  onRestore,
  onSave
}: {
  wslPath: string;
  isWsl: boolean;
  supportsSessionSettings: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onRestore: () => void;
  onSave: () => void;
}) {
  const disabled = !supportsSessionSettings || !isWsl;
  return (
    <Dialog
      title="设置会话"
      onClose={onClose}
      className="session-settings-dialog"
      closeOnOverlay={false}
      footer={
        <>
          <button type="button" className="secondary" onClick={onRestore} disabled={disabled}>
            恢复自动探测
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" onClick={onSave} disabled={disabled}>
            保存
          </button>
        </>
      }
    >
      <label className="session-path-field">
        <span>会话目录</span>
        <input
          value={wslPath}
          onChange={(event) => onChange(event.target.value)}
          placeholder={isWsl ? "WSL 内 Codex 目录，例如 ~/.codex" : "当前目标不需要手动设置"}
          disabled={disabled}
          autoFocus
        />
      </label>
    </Dialog>
  );
}
