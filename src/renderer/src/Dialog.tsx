import type { ReactNode } from "react";
import { useCallback, useRef, useEffect } from "react";
import { useDismissableOverlay } from "./useDismissableOverlay";

// 统一的弹窗骨架，覆盖 10 个 Dialog 组件中重复的 overlay/modal 模式。
// 用法：
//   <Dialog title="重命名" onClose={handleClose}>
//     <p>内容</p>
//   </Dialog>
//
// 选项：
//   - className       dialog 的额外类名，用于主题定制
//   - closeOnOverlay   点遮罩关闭（默认 true）
//   - busy             按钮禁用／加载态
//   - footer           底部按钮区域（可选，渲染在 children 下方）

export function Dialog({
  title,
  onClose,
  children,
  className = "",
  closeOnOverlay = true,
  busy = false,
  footer
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  closeOnOverlay?: boolean;
  busy?: boolean;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = `dialog-title-${title.replace(/\s+/g, "-")}`;

  // Escape 关闭（与 closeOnOverlay 独立，始终响应 Escape）
  useDismissableOverlay(!busy, onClose);

  // autofocus：首个子 input/textarea
  useEffect(() => {
    const timer = setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>(
        "[autoFocus], input:not([type=hidden]):not([disabled]), textarea:not([disabled])"
      );
      el?.focus();
      if (el && "select" in el) (el as HTMLInputElement).select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const handleOverlayClick = useCallback((event: React.MouseEvent) => {
    if (closeOnOverlay && event.target === event.currentTarget && !busy) onClose();
  }, [closeOnOverlay, busy, onClose]);

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={handleOverlayClick}>
      <section
        ref={dialogRef}
        className={`dialog${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" title="关闭" aria-label="关闭" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}
