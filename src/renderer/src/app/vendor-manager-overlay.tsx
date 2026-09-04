import type { ComponentProps } from "react";
import { VendorManagerDialog } from "../features/vendors/vendor-manager-dialog";

type VendorManagerOverlayProps = ComponentProps<typeof VendorManagerDialog> & {
  open: boolean;
};

// 供应商管理浮层只负责展示和参数转发，供应商业务状态仍由 App.tsx 管理。
export function VendorManagerOverlay({ open, ...dialogProps }: VendorManagerOverlayProps) {
  if (!open) return null;
  return <VendorManagerDialog {...dialogProps} />;
}
