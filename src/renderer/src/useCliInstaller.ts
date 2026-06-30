import { useEffect, useState } from "react";
import type { AiProviderId, AiTarget, CliEnvironmentStatus, CliInstallResult } from "./types";
import { CLI_INSTALLERS } from "../../shared/cliInstallers";
import type { CliInstallerState } from "./CliInstallerDialog";

// CLI 安装弹框的状态、环境检测与安装流程，从 App.tsx 抽出为自定义 Hook。
// 通过参数回调与 App 的 notice / error / loadTargets 协作。
export function useCliInstaller({
  selectedTarget,
  targetId,
  providerId,
  setNotice,
  setError,
  loadTargets
}: {
  selectedTarget: AiTarget | undefined;
  targetId: string;
  providerId: AiProviderId | "";
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  loadTargets: (providerId: AiProviderId, options?: { showLoading?: boolean }) => Promise<void>;
}) {
  const [cliInstallerOpen, setCliInstallerOpen] = useState(false);
  const [cliInstallerBusy, setCliInstallerBusy] = useState<CliInstallerState>(null);
  const [cliInstallResult, setCliInstallResult] = useState<CliInstallResult | null>(null);
  const [cliInstallError, setCliInstallError] = useState("");
  const [cliNodeMajor, setCliNodeMajor] = useState(24);
  const [cliEnvironmentByProvider, setCliEnvironmentByProvider] = useState<Partial<Record<AiProviderId, CliEnvironmentStatus>>>({});
  const [cliEnvironmentLoading, setCliEnvironmentLoading] = useState(false);

  useEffect(() => {
    return window.codexConsole.onOpenCliInstaller(() => {
      openCliInstallerDialog();
    });
    // IPC 监听只注册一次；openCliInstallerDialog 通过闭包读取最新状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cliInstallerOpen) return;
    void refreshCliEnvironments();
    // 仅在弹框打开/目标变化时刷新环境；refreshCliEnvironments 每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliInstallerOpen, targetId]);

  function openCliInstallerDialog() {
    setCliInstallerOpen(true);
    setCliInstallResult(null);
    setCliInstallError("");
    setNotice("");
  }

  async function refreshCliEnvironments() {
    setCliEnvironmentLoading(true);
    try {
      const nextTargetId = selectedTarget?.id || targetId || undefined;
      const entries = await Promise.all(
        CLI_INSTALLERS.map(async (installer) => {
          const status = await window.codexConsole.checkCliEnvironment({
            providerId: installer.providerId,
            targetId: nextTargetId
          });
          return [installer.providerId, status] as const;
        })
      );
      setCliEnvironmentByProvider(Object.fromEntries(entries) as Partial<Record<AiProviderId, CliEnvironmentStatus>>);
    } catch (environmentError: any) {
      setCliInstallError(environmentError?.message || "检测 CLI 环境失败。");
    } finally {
      setCliEnvironmentLoading(false);
    }
  }

  async function installAiCli(nextProviderId: AiProviderId) {
    const environment = cliEnvironmentByProvider[nextProviderId];
    const ensureNode = Boolean(environment && !environment.canInstallCli && environment.canInstallNodeWithNvm);
    const nextTargetId = selectedTarget?.id || targetId || undefined;
    setCliInstallerBusy(nextProviderId);
    setCliInstallError("");
    setCliInstallResult(null);
    setError("");
    try {
      const result = await window.codexConsole.installCli({
        providerId: nextProviderId,
        targetId: nextTargetId,
        nodeMajor: cliNodeMajor,
        ensureNode
      });
      setCliInstallResult(result);
      setNotice("CLI 安装完成。");
      await refreshCliEnvironments();
      if (providerId === nextProviderId) await loadTargets(nextProviderId, { showLoading: true });
    } catch (installError: any) {
      const message = installError?.message || "CLI 安装失败。";
      setCliInstallError(message);
      setError(message);
      await refreshCliEnvironments();
    } finally {
      setCliInstallerBusy(null);
    }
  }

  return {
    cliInstallerOpen,
    setCliInstallerOpen,
    cliInstallerBusy,
    cliInstallResult,
    cliInstallError,
    cliNodeMajor,
    setCliNodeMajor,
    cliEnvironmentByProvider,
    cliEnvironmentLoading,
    openCliInstallerDialog,
    refreshCliEnvironments,
    installAiCli
  };
}
