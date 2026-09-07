import { useState } from "react";
import type { AiSession, AiTarget } from "../types";
import { normalizeChosenDirectory } from "../features/sessions/new-session-paths";

export type PendingResumeSession = {
  session: AiSession;
  missingCwd: string;
  target?: AiTarget;
};

type NewSessionInput = {
  cwd: string;
  title: string;
  prompt: string;
  cliArgs: string;
};

type UseNewSessionDialogOptions = {
  defaultCwd: string;
  selectedTarget?: AiTarget;
  onCreate: (input: NewSessionInput) => void;
  onResume: (session: AiSession, cwd: string, target?: AiTarget) => void;
};

export function useNewSessionDialog({ defaultCwd, selectedTarget, onCreate, onResume }: UseNewSessionDialogOptions) {
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionCwd, setNewSessionCwd] = useState(defaultCwd);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionPrompt, setNewSessionPrompt] = useState("");
  const [newSessionCliArgs, setNewSessionCliArgs] = useState("");
  const [pendingResumeSession, setPendingResumeSession] = useState<PendingResumeSession | null>(null);

  function resetFields() {
    setNewSessionCwd(defaultCwd);
    setNewSessionTitle("");
    setNewSessionPrompt("");
    setNewSessionCliArgs("");
  }

  function openNewSessionDialog() {
    setPendingResumeSession(null);
    resetFields();
    setNewSessionDialogOpen(true);
  }

  function openResumeWithDirectory(session: AiSession, missingCwd: string, target?: AiTarget) {
    setPendingResumeSession({ session, missingCwd, target });
    resetFields();
    setNewSessionDialogOpen(true);
  }

  function closeNewSessionDialog() {
    setNewSessionDialogOpen(false);
    setPendingResumeSession(null);
  }

  async function chooseNewSessionDirectory() {
    const result = await window.codexConsole.chooseDirectory();
    if (!result.filePath) return;
    setNewSessionCwd(normalizeChosenDirectory(result.filePath, pendingResumeSession?.target || selectedTarget));
  }

  function confirmNewSessionDialog() {
    if (pendingResumeSession) {
      onResume(pendingResumeSession.session, newSessionCwd, pendingResumeSession.target);
    } else {
      onCreate({
        cwd: newSessionCwd,
        title: newSessionTitle,
        prompt: newSessionPrompt,
        cliArgs: newSessionCliArgs
      });
    }
    closeNewSessionDialog();
  }

  return {
    newSessionDialogOpen,
    newSessionCwd,
    newSessionTitle,
    setNewSessionTitle,
    newSessionPrompt,
    setNewSessionPrompt,
    newSessionCliArgs,
    setNewSessionCliArgs,
    pendingResumeSession,
    openNewSessionDialog,
    openResumeWithDirectory,
    closeNewSessionDialog,
    chooseNewSessionDirectory,
    confirmNewSessionDialog
  };
}
