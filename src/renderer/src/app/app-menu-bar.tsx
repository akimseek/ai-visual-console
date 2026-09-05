import type { LucideIcon } from "lucide-react";

// 应用内自绘菜单栏：鼠标移入展开下拉，支持二级子菜单。从 App.tsx 抽出为独立组件。

export type AppMenuItem = {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  action?: () => void;
  children?: AppMenuItem[];
};

export type AppMenuDefinition = {
  id: string;
  label: string;
  items: AppMenuItem[];
};

export function AppMenuBar({
  menus,
  openMenu,
  onOpenMenu
}: {
  menus: AppMenuDefinition[];
  openMenu: string;
  onOpenMenu: (menuId: string) => void;
}) {
  const renderItemLabel = (item: AppMenuItem) => {
    const Icon = item.icon;
    return (
      <span className="menu-item-content">
        {Icon && <Icon aria-hidden="true" size={15} strokeWidth={1.9} />}
        <span>{item.label}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </span>
    );
  };

  return (
    <nav
      className="app-menu-bar"
      aria-label="应用菜单"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseLeave={() => onOpenMenu("")}
    >
      <div className="app-menu-groups">
      {menus.map((menu) => {
        const active = openMenu === menu.id;
        return (
          <div key={menu.id} className="app-menu-root" onMouseEnter={() => onOpenMenu(menu.id)}>
            <button type="button" className={active ? "active" : ""} onClick={() => onOpenMenu(active ? "" : menu.id)}>
              {menu.label}
            </button>
            {active && (
              <div className="app-menu-dropdown" role="menu">
                {menu.items.map((item, index) =>
                  item.separator ? (
                    <div key={`${menu.id}:separator:${index}`} className="app-menu-separator" role="separator" />
                  ) : item.children?.length ? (
                    <div key={`${menu.id}:${item.label}`} className="app-menu-submenu">
                      <button type="button" role="menuitem" disabled={item.disabled} aria-haspopup="menu">
                        {renderItemLabel(item)}
                      </button>
                      {!item.disabled && (
                        <div className="app-menu-submenu-panel" role="menu">
                          {item.children.map((child) => (
                            <button
                              key={`${menu.id}:${item.label}:${child.label}`}
                              type="button"
                              role="menuitem"
                              className={child.danger ? "danger" : ""}
                              disabled={child.disabled}
                              onClick={() => {
                                if (child.disabled) return;
                                child.action?.();
                                onOpenMenu("");
                              }}
                            >
                              {renderItemLabel(child)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      key={`${menu.id}:${item.label}`}
                      type="button"
                      role="menuitem"
                      className={item.danger ? "danger" : ""}
                      disabled={item.disabled}
                      onClick={() => {
                        if (item.disabled) return;
                        item.action?.();
                        onOpenMenu("");
                      }}
                    >
                      {renderItemLabel(item)}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </nav>
  );
}
