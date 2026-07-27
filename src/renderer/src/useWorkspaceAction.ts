import { useState } from "react";

export function useWorkspaceAction({
  setError,
  setNotice,
  focusActiveInput
}: {
  setError: (message: string) => void;
  setNotice: (message: string, action?: { label: string; onClick: () => void }, tone?: "success" | "error") => void;
  focusActiveInput: () => void;
}) {
  const [workspaceBusyMessage, setWorkspaceBusyMessage] = useState("");
  const [workspaceFocusRequest, setWorkspaceFocusRequest] = useState(0);

  async function runWorkspaceAction(
    message: string,
    action: () => Promise<unknown>,
    options: { errorAsNotice?: boolean } = {}
  ) {
    setError("");
    setWorkspaceBusyMessage(message);
    try {
      await action();
    } catch (error: any) {
      const failureMessage = error?.message || "操作失败。";
      if (options.errorAsNotice) setNotice(failureMessage, undefined, "error");
      else setError(failureMessage);
    } finally {
      setWorkspaceBusyMessage("");
      setWorkspaceFocusRequest((current) => current + 1);
      window.setTimeout(focusActiveInput, 0);
    }
  }

  return { workspaceBusyMessage, workspaceFocusRequest, runWorkspaceAction };
}
