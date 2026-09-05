import { describe, expect, it, vi } from "vitest";
import { flattenAppMenuCommands } from "./command-palette";
import { Download, FileText, Settings } from "lucide-react";

describe("flattenAppMenuCommands", () => {
  it("只保留可执行项并展开嵌套菜单", () => {
    const settings = vi.fn();
    const markdown = vi.fn();
    const menus = [{
      id: "file",
      label: "文件",
      items: [
        { label: "设置", icon: Settings, action: settings },
        { label: "不可用", disabled: true, action: vi.fn() },
        { separator: true, label: "" },
        { label: "导出", icon: Download, children: [{ label: "Markdown", icon: FileText, action: markdown }] }
      ]
    }];

    const commands = flattenAppMenuCommands(menus);

    expect(commands.map((command) => [command.label, command.group])).toEqual([
      ["设置", "文件"],
      ["Markdown", "文件 / 导出"]
    ]);
    expect(commands[0]?.icon).toBe(Settings);
    expect(commands[1]?.icon).toBe(FileText);
  });
});
