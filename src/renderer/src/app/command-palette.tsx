import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { Command as CommandIcon, CornerDownLeft, Search, X } from "lucide-react";
import type { AppMenuDefinition, AppMenuItem } from "./app-menu-bar";
import { IconButton } from "../components/icon-button";

export type AppCommandPaletteItem = {
  id: string;
  label: string;
  group: string;
  icon?: AppMenuItem["icon"];
  action: () => void;
};

// 菜单和命令面板共用同一份 action，保证禁用条件和实际执行路径始终一致。
export function flattenAppMenuCommands(menus: AppMenuDefinition[]): AppCommandPaletteItem[] {
  const commands: AppCommandPaletteItem[] = [];

  const visit = (items: AppMenuItem[], group: string, path: string[]) => {
    items.forEach((item) => {
      if (item.separator || item.disabled) return;
      if (item.children?.length) {
        visit(item.children, `${group} / ${item.label}`, [...path, item.label]);
        return;
      }
      if (!item.action) return;
      commands.push({
        id: [...path, item.label].join(":"),
        label: item.label,
        group,
        icon: item.icon,
        action: item.action
      });
    });
  };

  menus.forEach((menu) => visit(menu.items, menu.label, [menu.id]));
  return commands;
}

export function CommandPalette({
  menus,
  open,
  onClose
}: {
  menus: AppMenuDefinition[];
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commands = useMemo(() => flattenAppMenuCommands(menus), [menus]);
  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return commands;
    return commands.filter((command) => `${command.label} ${command.group}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, filteredCommands.length - 1)));
  }, [filteredCommands.length]);

  if (!open) return null;

  function executeCommand(index: number) {
    const command = filteredCommands[index];
    if (!command) return;
    onClose();
    command.action();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, filteredCommands.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      executeCommand(activeIndex);
    }
  }

  function handleOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="command-palette-overlay" role="presentation" onMouseDown={handleOverlayMouseDown}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <header className="command-palette-header">
          <div className="command-palette-heading">
            <CommandIcon aria-hidden="true" size={18} strokeWidth={2} />
            <h2 id="command-palette-title">命令面板</h2>
          </div>
          <IconButton icon={X} label="关闭命令面板" onClick={onClose} />
        </header>
        <div className="command-palette-search">
          <Search aria-hidden="true" size={16} strokeWidth={2} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索命令"
            aria-label="搜索命令"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="command-palette-list" role="listbox" aria-label="可用命令">
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">没有匹配的命令</div>
          ) : filteredCommands.map((command, index) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => executeCommand(index)}
              >
                <span className="command-palette-item-icon">
                  {Icon ? <Icon aria-hidden="true" size={16} strokeWidth={1.9} /> : <CommandIcon aria-hidden="true" size={16} strokeWidth={1.9} />}
                </span>
                <span className="command-palette-item-copy">
                  <strong>{command.label}</strong>
                  <small>{command.group}</small>
                </span>
                {index === activeIndex && <CornerDownLeft aria-hidden="true" size={15} strokeWidth={2} />}
              </button>
            );
          })}
        </div>
        <footer className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
          <span><kbd>Enter</kbd>执行</span>
          <span><kbd>Esc</kbd>关闭</span>
        </footer>
      </section>
    </div>
  );
}
