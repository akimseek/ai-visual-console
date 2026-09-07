import { useLayoutEffect, useRef, useState } from "react";

// 右键上下文菜单：会话列表项菜单与终端标签页菜单，从 App.tsx 的内联 JSX 抽出为展示组件。

export function useViewportMenuPosition(x: number, y: number) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const reposition = () => {
      const element = menuRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const margin = 8;
      const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
      // clientX/clientY 是视口坐标；固定定位菜单需要限制在当前窗口内。
      setPosition({
        x: Math.min(Math.max(x, margin), maxX),
        y: Math.min(Math.max(y, margin), maxY)
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [x, y]);

  return { menuRef, position };
}

export function SessionContextMenu({
  menu,
  supportsTrash,
  canDuplicate,
  onDuplicate,
  onRename,
  onOpenFolder,
  onRestore,
  onPurge,
  onDelete,
  onClose
}: {
  menu: { x: number; y: number; view: "active" | "trash" };
  supportsTrash: boolean;
  canDuplicate: boolean;
  onDuplicate: () => void;
  onRename: () => void;
  onOpenFolder: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { menuRef, position } = useViewportMenuPosition(menu.x, menu.y);
  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        重命名
      </button>
      {canDuplicate && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onDuplicate();
            onClose();
          }}
        >
          复制
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenFolder();
          onClose();
        }}
      >
        打开目录
      </button>
      {supportsTrash && menu.view === "trash" ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onRestore();
              onClose();
            }}
          >
            恢复
          </button>
          <button
            type="button"
            className="danger"
            role="menuitem"
            onClick={() => {
              onPurge();
              onClose();
            }}
          >
            彻底删除
          </button>
        </>
      ) : supportsTrash ? (
        <button
          type="button"
          className="danger"
          role="menuitem"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          删除
        </button>
      ) : null}
    </div>
  );
}

export function TabContextMenu({
  menu,
  canCloseOthers,
  canCloseAll,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onDismiss
}: {
  menu: { x: number; y: number };
  canCloseOthers: boolean;
  canCloseAll: boolean;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onDismiss: () => void;
}) {
  const { menuRef, position } = useViewportMenuPosition(menu.x, menu.y);
  return (
    <div
      ref={menuRef}
      className="terminal-context-menu terminal-tab-menu"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCloseTab();
          onDismiss();
        }}
      >
        关闭
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCloseOthers}
        onClick={() => {
          onCloseOthers();
          onDismiss();
        }}
      >
        关闭其他
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCloseAll}
        onClick={() => {
          onCloseAll();
          onDismiss();
        }}
      >
        关闭所有
      </button>
    </div>
  );
}
