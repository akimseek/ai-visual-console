import { useState } from "react";

export function useWorkspaceAction({
  setError,
  focusActiveInput
}: {
  setError: (message: string) => void;
  focusActiveInput: () => void;
}) {
  const [workspaceBusyMessage, setWorkspaceBusyMessage] = useState("");
  const [workspaceFocusRequest, setWorkspaceFocusRequest] = useState(0);

  async function runWorkspaceAction(message: string, action: () => Promise<unknown>) {
    setError("");
    setWorkspaceBusyMessage(message);
    try {
      await action();
    } catch (error: any) {
      setError(error?.message || "操作失败。");
    } finally {
      setWorkspaceBusyMessage("");
      setWorkspaceFocusRequest((current) => current + 1);
      window.setTimeout(focusActiveInput, 0);
    }
  }

  return { workspaceBusyMessage, workspaceFocusRequest, runWorkspaceAction };
}
