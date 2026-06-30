// 右键上下文菜单：会话列表项菜单与终端标签页菜单，从 App.tsx 的内联 JSX 抽出为展示组件。

export function SessionContextMenu({
  menu,
  supportsTrash,
  onOpenFolder,
  onRestore,
  onPurge,
  onDelete,
  onClose
}: {
  menu: { x: number; y: number; view: "active" | "trash" };
  supportsTrash: boolean;
  onOpenFolder: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="context-menu"
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
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
            role="menuitem"
            onClick={() => {
              onRestore();
              onClose();
            }}
          >
            恢复
          </button>
          <button
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
  return (
    <div
      className="terminal-context-menu terminal-tab-menu"
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        role="menuitem"
        onClick={() => {
          onCloseTab();
          onDismiss();
        }}
      >
        关闭
      </button>
      <button
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
