import type { AiProviderId, AiTarget, CliEnvironmentStatus, CliInstallResult } from '../types';
import { CliInstallerDialog, type CliInstallerState } from '../features/settings/cli-installer-dialog';

type CliInstallerOverlayProps = {
  open: boolean;
  busy: CliInstallerState;
  environments: Partial<Record<AiProviderId, CliEnvironmentStatus>>;
  environmentLoading: boolean;
  nodeMajor: number;
  result: CliInstallResult | null;
  error: string;
  target?: AiTarget;
  onNodeMajorChange: (value: number) => void;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
  onInstall: (providerId: AiProviderId) => void | Promise<void>;
};

/** CLI 安装弹窗的展示边界，检测和安装动作由页面 Hook 负责。 */
export function CliInstallerOverlay({
  open,
  busy,
  environments,
  environmentLoading,
  nodeMajor,
  result,
  error,
  target,
  onNodeMajorChange,
  onRefresh,
  onClose,
  onInstall
}: CliInstallerOverlayProps) {
  if (!open) return null;
  return (
    <CliInstallerDialog
      busy={busy}
      environments={environments}
      environmentLoading={environmentLoading}
      nodeMajor={nodeMajor}
      result={result}
      error={error}
      target={target}
      onNodeMajorChange={onNodeMajorChange}
      onRefresh={onRefresh}
      onClose={onClose}
      onInstall={onInstall}
    />
  );
}
