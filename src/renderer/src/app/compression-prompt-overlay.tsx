import type { ComponentProps } from "react";
import { CompressionPromptManagerDialog } from "../features/settings/compression-prompt-manager-dialog";

type CompressionPromptOverlayProps = ComponentProps<typeof CompressionPromptManagerDialog> & {
  open: boolean;
};

// 压缩提示词浮层只负责展示和参数转发，提示词状态与业务操作仍由 App.tsx 管理。
export function CompressionPromptOverlay({ open, ...dialogProps }: CompressionPromptOverlayProps) {
  if (!open) return null;
  return <CompressionPromptManagerDialog {...dialogProps} />;
}
