import type { GatewayExternalApiStatus, GatewayPortStatus } from '../types';
import { GatewayPortDialog } from '../features/settings/gateway-port-dialog';

type GatewayPortOverlayProps = {
  open: boolean;
  draft: string;
  failureThresholdDraft: string;
  circuitFailureThresholdDraft: string;
  circuitDurationDraft: string;
  status: GatewayPortStatus | null;
  externalApiStatus: GatewayExternalApiStatus | null;
  externalApiToken: string;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onFailureThresholdChange: (value: string) => void;
  onCircuitFailureThresholdChange: (value: string) => void;
  onCircuitDurationChange: (value: string) => void;
  onSetEnabled: (enabled: boolean) => void;
  onSetExternalApiEnabled: (enabled: boolean) => void;
  onRotateExternalApiToken: () => void;
  onCopyExternalApiToken: () => void;
  onClose: () => void;
  onSave: () => void;
};

/** 网关设置弹窗的展示边界，配置读取和保存动作由现有 Hook 负责。 */
export function GatewayPortOverlay({
  open,
  draft,
  failureThresholdDraft,
  circuitFailureThresholdDraft,
  circuitDurationDraft,
  status,
  externalApiStatus,
  externalApiToken,
  error,
  busy,
  onChange,
  onFailureThresholdChange,
  onCircuitFailureThresholdChange,
  onCircuitDurationChange,
  onSetEnabled,
  onSetExternalApiEnabled,
  onRotateExternalApiToken,
  onCopyExternalApiToken,
  onClose,
  onSave
}: GatewayPortOverlayProps) {
  if (!open) return null;
  return (
    <GatewayPortDialog
      draft={draft}
      failureThresholdDraft={failureThresholdDraft}
      circuitFailureThresholdDraft={circuitFailureThresholdDraft}
      circuitDurationDraft={circuitDurationDraft}
      status={status}
      externalApiStatus={externalApiStatus}
      externalApiToken={externalApiToken}
      error={error}
      busy={busy}
      onChange={onChange}
      onFailureThresholdChange={onFailureThresholdChange}
      onCircuitFailureThresholdChange={onCircuitFailureThresholdChange}
      onCircuitDurationChange={onCircuitDurationChange}
      onSetEnabled={onSetEnabled}
      onSetExternalApiEnabled={onSetExternalApiEnabled}
      onRotateExternalApiToken={onRotateExternalApiToken}
      onCopyExternalApiToken={onCopyExternalApiToken}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
