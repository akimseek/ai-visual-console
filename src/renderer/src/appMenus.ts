import type { SessionExportFormat } from "./types";
import type { AppMenuDefinition } from "./AppMenuBar";

type AppMenuActions = {
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
  hasTarget,
  isWslTarget,
  hasActiveSession,
  actions
}: {
  supportsSkills: boolean;
  supportsSessionSettings: boolean;
  supportsExport: boolean;
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
        { label: "管理 skill", disabled: !supportsSkills || !hasTarget, action: actions.manageSkills },
        { label: "设置会话", disabled: !supportsSessionSettings || !isWslTarget, action: actions.openSessionSettings },
        { label: "设置网关端口", action: actions.openGatewayPortSettings },
        { separator: true, label: "" },
        {
          label: "导出",
          disabled: exportDisabled,
          children: [
            { label: "导出 Markdown", disabled: exportDisabled, action: () => actions.exportSession("markdown") },
            { label: "导出 JSON", disabled: exportDisabled, action: () => actions.exportSession("json") },
            { label: "导出 HTML", disabled: exportDisabled, action: () => actions.exportSession("html") }
          ]
        },
        { separator: true, label: "" },
        { label: "退出", action: actions.quit }
      ]
    },
    {
      id: "toolbox",
      label: "工具箱",
      items: [
        { label: "供应商管理", disabled: !hasTarget, action: actions.manageVendors },
        { label: "压缩提示", action: actions.manageCompressionPrompts }
      ]
    },
    { id: "terminal", label: "终端", items: [{ label: "新建终端", action: actions.openSystemTerminal }] },
    {
      id: "help",
      label: "帮助",
      items: [
        { label: "安装 CLI", action: actions.installCli },
        { separator: true, label: "" },
        { label: "导出诊断信息", action: actions.exportDiagnostics },
        { label: "打开日志目录", action: actions.openLogDirectory },
        { label: "关于 AI 可视化控制台", action: actions.showAbout }
      ]
    }
  ];
}
