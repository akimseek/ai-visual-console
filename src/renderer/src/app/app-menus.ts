import type { SessionExportFormat } from "../types";
import type { AppMenuDefinition } from "./app-menu-bar";
import { Command, Download, FileText, FolderOpen, Info, Landmark, LogOut, Settings, SlidersHorizontal, SquareTerminal, Wrench } from "lucide-react";

type AppMenuActions = {
  openCommandPalette: () => void;
  manageSkills: () => void;
  openSessionSettings: () => void;
  openGatewayPortSettings: () => void;
  exportSession: (format: SessionExportFormat) => void;
  quit: () => void;
  manageVendors: () => void;
  manageCompressionPrompts: () => void;
  openSystemTerminal: () => void;
  installCli: () => void;
  exportDiagnostics: () => void;
  openLogDirectory: () => void;
  showAbout: () => void;
};

export function createAppMenus({
  supportsSkills,
  supportsSessionSettings,
  supportsExport,
  supportsVendorManagement,
  hasTarget,
  isWslTarget,
  hasActiveSession,
  actions
}: {
  supportsSkills: boolean;
  supportsSessionSettings: boolean;
  supportsExport: boolean;
  supportsVendorManagement: boolean;
  hasTarget: boolean;
  isWslTarget: boolean;
  hasActiveSession: boolean;
  actions: AppMenuActions;
}): AppMenuDefinition[] {
  const exportDisabled = !supportsExport || !hasActiveSession;
  return [
    {
      id: "file",
      label: "文件",
      items: [
        { label: "管理 skill", icon: Wrench, disabled: !supportsSkills || !hasTarget, action: actions.manageSkills },
        { label: "设置会话", icon: Settings, disabled: !supportsSessionSettings || !isWslTarget, action: actions.openSessionSettings },
        { label: "设置", icon: Settings, action: actions.openGatewayPortSettings },
        { separator: true, label: "" },
        {
          label: "导出",
          icon: Download,
          disabled: exportDisabled,
          children: [
            { label: "导出 Markdown", icon: FileText, disabled: exportDisabled, action: () => actions.exportSession("markdown") },
            { label: "导出 JSON", icon: FileText, disabled: exportDisabled, action: () => actions.exportSession("json") },
            { label: "导出 HTML", icon: FileText, disabled: exportDisabled, action: () => actions.exportSession("html") }
          ]
        },
        { separator: true, label: "" },
        { label: "退出", icon: LogOut, danger: true, action: actions.quit }
      ]
    },
    {
      id: "toolbox",
      label: "工具箱",
      items: [
        { label: "供应商管理", icon: Landmark, disabled: !supportsVendorManagement || !hasTarget, action: actions.manageVendors },
        { label: "压缩提示", icon: SlidersHorizontal, action: actions.manageCompressionPrompts }
      ]
    },
    { id: "terminal", label: "终端", items: [{ label: "新建终端", icon: SquareTerminal, action: actions.openSystemTerminal }] },
    {
      id: "help",
      label: "帮助",
      items: [
        { label: "命令面板", icon: Command, shortcut: "Ctrl + K", action: actions.openCommandPalette },
        { separator: true, label: "" },
        { label: "安装 CLI", icon: Wrench, action: actions.installCli },
        { separator: true, label: "" },
        { label: "导出诊断信息", icon: Download, action: actions.exportDiagnostics },
        { label: "打开日志目录", icon: FolderOpen, action: actions.openLogDirectory },
        { label: "关于", icon: Info, action: actions.showAbout }
      ]
    }
  ];
}
