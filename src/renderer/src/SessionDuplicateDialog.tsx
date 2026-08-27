import type { AiSession } from "./types";
import { Dialog } from "./Dialog";

export function SessionDuplicateDialog({
  session,
  value,
  error,
  busy,
  onChange,
  onClose,
  onSave
}: {
  session: AiSession;
  value: string;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      title="复制会话"
      onClose={onClose}
      className="session-duplicate-dialog"
      busy={busy}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="session-duplicate-form" disabled={busy}>
            复制
          </button>
        </>
      }
    >
      <form
        id="session-duplicate-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label className="session-template-field">
          <span>会话名称（可选）</span>
          <input
            value={value}
            maxLength={120}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            placeholder="留空则使用原会话标题"
            autoFocus
          />
          {error && <small className="form-field-error">{error}</small>}
        </label>
        <p className="session-rename-source" title={session.title}>
          原会话：{session.title}
        </p>
      </form>
    </Dialog>
  );
}
