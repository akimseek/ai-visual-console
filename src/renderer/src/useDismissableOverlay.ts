import { useEffect, useRef } from "react";

// 注册 mousedown/scroll/Escape 全局监听，在 overlay 打开时关闭它。
// 四个位置重复了完全相同的 useEffect 结构，统一到此 hook。
// onClose 用 ref 持有，避免内联闭包导致每帧重订阅。
export function useDismissableOverlay(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const close = () => onCloseRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}