import { useEffect, useRef } from "react";
import type { AiSession } from "./types";

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
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="session-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-rename-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="session-rename-title">重命名会话</h2>
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
            <span>会话名称</span>
            <input
              ref={inputRef}
              value={value}
              maxLength={120}
              disabled={busy}
              onChange={(event) => onChange(event.target.value)}
              placeholder="请输入会话名称"
            />
            {error && <small className="form-field-error">{error}</small>}
          </label>
          <p className="session-rename-source" title={session.sourceTitle || session.title}>
            自动标题：{session.sourceTitle || session.title}
          </p>
          <footer>
            <button type="button" className="secondary" onClick={onRestore} disabled={busy || !session.metadata?.customTitle}>
              恢复自动标题
            </button>
            <span />
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy || !value.trim()}>
              保存
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
