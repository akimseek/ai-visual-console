import { useEffect, useState } from "react";
import type { AiProviderId, AiTarget } from "../../types";
import type { SessionView } from "./use-session-loader";
import { captureError } from "../../hooks/error-utils";

export function useSessionSettings({
  selectedTarget,
  view,
  loadTargets,
  loadSessions,
  invalidateLoadedView,
  setError,
  setNotice
}: {
  selectedTarget?: AiTarget;
  view: SessionView;
  loadTargets: (providerId: AiProviderId, options?: { showLoading?: boolean }) => Promise<void>;
  loadSessions: (targetId: string, view: SessionView, force?: boolean) => Promise<void>;
  invalidateLoadedView: (targetId: string, view: SessionView) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [wslPathDraft, setWslPathDraft] = useState("");

  useEffect(() => {
    setWslPathDraft(selectedTarget?.kind === "wsl" ? selectedTarget.codexHome || "~/.codex" : "");
  }, [selectedTarget?.id, selectedTarget?.codexHome, selectedTarget?.kind]);

  function openSessionSettingsDialog() {
    setWslPathDraft(selectedTarget?.kind === "wsl" ? selectedTarget.codexHome || "~/.codex" : "");
    setSessionSettingsOpen(true);
    setNotice("");
  }

  async function refreshWslTarget(distro: string) {
    await loadTargets("codex", { showLoading: true });
    const targetId = `wsl:${distro}`;
    invalidateLoadedView(targetId, view);
    await loadSessions(targetId, view, true);
  }

  async function configureWslCodexHome() {
    const distro = selectedTarget?.distro;
    const value = wslPathDraft.trim();
    if (!distro || !value) return;
    setError("");
    setNotice("");
    try {
      await window.codexConsole.setWslCodexHome(distro, value);
      setNotice("WSL Codex 目录已保存。");
      setSessionSettingsOpen(false);
      await refreshWslTarget(distro);
    } catch (error) {
      setNotice(captureError(error, "configureWslCodexHome", "保存 WSL Codex 目录失败。"));
    }
  }

  async function clearWslCodexHome() {
    const distro = selectedTarget?.distro;
    if (!distro) return;
    setError("");
    setNotice("");
    try {
      await window.codexConsole.clearWslCodexHome(distro);
      setNotice("已恢复自动探测会话目录。");
      setSessionSettingsOpen(false);
      await refreshWslTarget(distro);
    } catch (error) {
      setNotice(captureError(error, "clearWslCodexHome", "恢复自动探测失败。"));
    }
  }

  return {
    sessionSettingsOpen,
    setSessionSettingsOpen,
    wslPathDraft,
    setWslPathDraft,
    openSessionSettingsDialog,
    configureWslCodexHome,
    clearWslCodexHome
  };
}
