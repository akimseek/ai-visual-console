import { SquareTerminal } from "lucide-react";
import { Dialog } from "./dialog";

export function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <Dialog
      title="关于"
      onClose={onClose}
      className="about-dialog"
      footer={<button type="button" className="ui-button ui-button-primary" onClick={onClose}>关闭</button>}
    >
      <div className="about-product">
        <div className="about-product-icon" aria-hidden="true"><SquareTerminal size={22} strokeWidth={1.8} /></div>
        <div>
          <strong>AI 可视化控制台</strong>
          <span>AI CLI 会话与本地 Gateway 管理</span>
        </div>
      </div>
      <dl className="about-details">
        <div>
          <dt>版本</dt>
          <dd>{version || "正在读取"}</dd>
        </div>
      </dl>
      <p className="about-description">统一管理 Codex、Claude Code、Gemini 与 Qoder 会话、供应商配置和请求路由。</p>
    </Dialog>
  );
}
