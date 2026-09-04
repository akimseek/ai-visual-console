import type { AiProviderSummary, AiTarget } from '../types';
import { ProviderStatusDialog } from '../components/provider-status-dialog';

type ProviderStatusOverlayProps = {
  open: boolean;
  provider?: AiProviderSummary;
  target?: AiTarget;
  targetCount: number;
  onClose: () => void;
  onRescan: () => void;
  onRefresh: () => void;
};

/** Provider 状态弹窗的展示边界，数据查询和刷新动作由页面负责。 */
export function ProviderStatusOverlay({
  open,
  provider,
  target,
  targetCount,
  onClose,
  onRescan,
  onRefresh
}: ProviderStatusOverlayProps) {
  if (!open) return null;
  return (
    <ProviderStatusDialog
      provider={provider}
      target={target}
      targetCount={targetCount}
      onClose={onClose}
      onRescan={onRescan}
      onRefresh={onRefresh}
    />
  );
}
