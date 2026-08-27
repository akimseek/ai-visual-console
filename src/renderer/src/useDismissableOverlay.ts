import { useEffect, useRef } from "react";

// 只注册 Escape 全局监听；点击遮罩由 Dialog 自身判断，避免输入框拖选或页面自动滚动时误关闭弹框。
// onClose 用 ref 持有，避免内联闭包导致每帧重订阅。
export function useDismissableOverlay(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}
