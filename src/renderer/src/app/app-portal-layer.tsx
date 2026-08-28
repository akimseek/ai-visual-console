import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import type { AiSession } from "../types";
import { SessionRenameDialog } from "../features/sessions/session-rename-dialog";
import { SessionDuplicateDialog } from "../features/sessions/session-duplicate-dialog";

export function AppPortalLayer({
  rename,
  duplicate,
  workspaceMessage
}: {
  rename: {
    session: AiSession | null;
    value: string;
    error: string;
    busy: boolean;
    onChange: (value: string) => void;
    onClose: () => void;
    onRestore: () => void;
    onSave: () => void;
  };
  duplicate: {
    session: AiSession | null;
    value: string;
    error: string;
    busy: boolean;
    onChange: (value: string) => void;
    onClose: () => void;
    onSave: () => void;
  };
  workspaceMessage: string;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {rename.session && (
        <SessionRenameDialog
          session={rename.session}
          value={rename.value}
          error={rename.error}
          busy={rename.busy}
          onChange={rename.onChange}
          onClose={rename.onClose}
          onRestore={rename.onRestore}
          onSave={rename.onSave}
        />
      )}
      {duplicate.session && (
        <SessionDuplicateDialog
          session={duplicate.session}
          value={duplicate.value}
          error={duplicate.error}
          busy={duplicate.busy}
          onChange={duplicate.onChange}
          onClose={duplicate.onClose}
          onSave={duplicate.onSave}
        />
      )}
      {workspaceMessage && <WorkspaceActionOverlay message={workspaceMessage} />}
    </>,
    document.body
  );
}

function WorkspaceActionOverlay({ message }: { message: string }) {
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const blockKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={overlayRef}
      className="workspace-action-indicator"
      role="status"
      aria-live="polite"
      aria-busy="true"
      tabIndex={-1}
      onKeyDown={blockKeyboard}
      onKeyUp={blockKeyboard}
    >
      <span>{message}</span>
    </div>
  );
}
