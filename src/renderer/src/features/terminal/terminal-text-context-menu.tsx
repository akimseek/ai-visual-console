import { useEffect, useRef } from "react";
import { useViewportMenuPosition } from "./context-menus";

type TerminalTextContextMenuProps = {
  menu: { x: number; y: number; canCopy: boolean; canPaste: boolean };
  onCopy: () => void;
  onPaste: () => void;
  onDismiss: () => void;
};

/** Shared native-like menu for text input in every terminal surface. */
export function TerminalTextContextMenu({
  menu,
  onCopy,
  onPaste,
  onDismiss
}: TerminalTextContextMenuProps) {
  const { menuRef, position } = useViewportMenuPosition(menu.x, menu.y);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".terminal-context-menu")) return;
      dismissRef.current();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissRef.current();
    };
    const dismissOnScroll = () => dismissRef.current();

    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, []);

  const run = (action: () => void) => {
    action();
    dismissRef.current();
  };

  return (
    <div
      ref={menuRef}
      className="terminal-context-menu"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" disabled={!menu.canCopy} onClick={() => run(onCopy)}>
        {"\u590d\u5236"}
      </button>
      <button type="button" role="menuitem" disabled={!menu.canPaste} onClick={() => run(onPaste)}>
        {"\u7c98\u8d34"}
      </button>
    </div>
  );
}
