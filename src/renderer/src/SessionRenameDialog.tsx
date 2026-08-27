import type { AiSession } from "./types";
import { Dialog } from "./Dialog";

export function SessionRenameDialog({
  session,
  value,
  error,
  busy,
  onChange,
  onClose,
  onRestore,
  onSave
}: {
  session: AiSession;
  value: string;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onRestore: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      title="重命名会话"
      onClose={onClose}
      className="session-rename-dialog"
      busy={busy}
      footer={
        <>
          <button type="button" className="secondary" onClick={onRestore} disabled={busy || !session.metadata?.customTitle}>
            恢复自动标题
          </button>
          <span />
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="session-rename-form" disabled={busy || !value.trim()}>
            保存
          </button>
        </>
      }
    >
      <form
        id="session-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label className="session-template-field">
          <span>会话名称</span>
          <input
            value={value}
            maxLength={120}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            placeholder="请输入会话名称"
            autoFocus
          />
          {error && <small className="form-field-error">{error}</small>}
        </label>
        <p className="session-rename-source" title={session.sourceTitle || session.title}>
          自动标题：{session.sourceTitle || session.title}
        </p>
      </form>
    </Dialog>
  );
}
