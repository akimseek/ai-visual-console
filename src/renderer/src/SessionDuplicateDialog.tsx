import { useEffect, useRef } from "react";
import type { AiSession } from "./types";

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
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="session-duplicate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-duplicate-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="session-duplicate-title">复制会话</h2>
          <button type="button" title="关闭" onClick={onClose} disabled={busy}>
            x
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label className="session-template-field">
            <span>会话名称（可选）</span>
            <input
              ref={inputRef}
              value={value}
              maxLength={120}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
              placeholder="留空则使用原会话标题"
            />
            {error && <small className="form-field-error">{error}</small>}
          </label>
          <p className="session-rename-source" title={session.title}>
            原会话：{session.title}
          </p>
          <footer>
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy}>
              复制
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
