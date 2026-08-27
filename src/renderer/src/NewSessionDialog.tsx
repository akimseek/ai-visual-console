import { Dialog } from "./Dialog";

// 新会话 / 恢复历史会话的工作目录设置弹框，从 App.tsx 的内联 JSX 抽出为展示组件。
export function NewSessionDialog({
  pendingResume,
  supportsCustomCwd,
  cwd,
  title,
  prompt,
  cliArgs,
  onChooseDirectory,
  onTitleChange,
  onPromptChange,
  onCliArgsChange,
  onClose,
  onConfirm
}: {
  pendingResume: { missingCwd: string } | null;
  supportsCustomCwd: boolean;
  cwd: string;
  title: string;
  prompt: string;
  cliArgs: string;
  onChooseDirectory: () => void;
  onTitleChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onCliArgsChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={pendingResume ? "设置工作目录" : "新会话"}
      onClose={onClose}
      className="new-session-dialog"
      closeOnOverlay={false}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" onClick={onConfirm}>
            {pendingResume ? "继续打开" : "打开"}
          </button>
        </>
      }
    >
      {pendingResume && (
        <div className="missing-directory-notice">
          <strong>原工作目录不存在</strong>
          <code title={pendingResume.missingCwd}>{pendingResume.missingCwd}</code>
          <span>请选择新的工作目录后继续打开此历史会话。</span>
        </div>
      )}
      {supportsCustomCwd && (
        <div className="directory-field">
          <span>工作目录</span>
          <code title={cwd}>{cwd}</code>
          <button type="button" onClick={onChooseDirectory}>
            设置工作目录
          </button>
        </div>
      )}
      {!pendingResume && (
        <>
          <label className="session-template-field compact">
            <span>会话标题</span>
            <input
              value={title}
              maxLength={120}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="可选，便于在历史列表中识别"
            />
          </label>
          <label className="session-template-field">
            <span>启动提示词</span>
            <textarea
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder="打开新会话后自动发送，可留空"
              rows={4}
            />
          </label>
          <label className="session-template-field compact">
            <span>CLI 参数</span>
            <input
              value={cliArgs}
              onChange={(event) => onCliArgsChange(event.target.value)}
              placeholder='例如：--model gpt-5-codex --sandbox workspace-write'
            />
          </label>
        </>
      )}
    </Dialog>
  );
}
