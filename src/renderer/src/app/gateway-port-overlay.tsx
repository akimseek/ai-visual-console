import type { GatewayPortStatus } from '../types';
import { GatewayPortDialog } from '../features/settings/gateway-port-dialog';

type GatewayPortOverlayProps = {
  open: boolean;
  draft: string;
  failureThresholdDraft: string;
  circuitFailureThresholdDraft: string;
  circuitDurationDraft: string;
  status: GatewayPortStatus | null;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onFailureThresholdChange: (value: string) => void;
  onCircuitFailureThresholdChange: (value: string) => void;
  onCircuitDurationChange: (value: string) => void;
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
  error,
  busy,
  onChange,
  onFailureThresholdChange,
  onCircuitFailureThresholdChange,
  onCircuitDurationChange,
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
      error={error}
      busy={busy}
      onChange={onChange}
      onFailureThresholdChange={onFailureThresholdChange}
      onCircuitFailureThresholdChange={onCircuitFailureThresholdChange}
      onCircuitDurationChange={onCircuitDurationChange}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
