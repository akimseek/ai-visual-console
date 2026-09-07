import { useState } from "react";
import type { CompressionPrompt } from "../../types";
import { formatRelative } from "../../lib/format";
import { Dialog } from "../../components/dialog";
import {
  compressionPromptPreview,
  type CompressionPromptDraft,
  type CompressionPromptFieldErrors,
  type CompressionPromptFieldName
} from "./compression-prompt";

// 压缩提示管理弹框：列表 / 编辑两种模式，生成后由调用方复制到剪贴板。从 App.tsx 抽出为独立组件。

export function CompressionPromptManagerDialog({
  prompts,
  draft,
  mode,
  busy,
  error,
  fieldErrors,
  toast,
  onDraftChange,
  onFieldErrorClear,
  onNew,
  onEdit,
  onGenerate,
  onSave,
  onDelete,
  onBack,
  onClose
}: {
  prompts: CompressionPrompt[];
  draft: CompressionPromptDraft;
  mode: "list" | "form";
  busy: string;
  error: string;
  fieldErrors: CompressionPromptFieldErrors;
  toast: { message: string; tone: "success" | "error" } | null;
  onDraftChange: (draft: CompressionPromptDraft) => void;
  onFieldErrorClear: (field: CompressionPromptFieldName) => void;
  onNew: () => void;
  onEdit: (prompt: CompressionPrompt) => void;
  onGenerate: (prompt: CompressionPrompt) => void | Promise<void>;
  onSave: () => void;
  onDelete: (promptId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [deleteCandidate, setDeleteCandidate] = useState<CompressionPrompt | null>(null);
  const deleteCandidateExists = deleteCandidate && prompts.some((prompt) => prompt.id === deleteCandidate.id);

  function updateDraft(field: CompressionPromptFieldName, value: string) {
    onFieldErrorClear(field);
    onDraftChange({ ...draft, [field]: value });
  }

  return (
    <Dialog
      title="压缩提示管理"
      onClose={onClose}
      className="compression-manager-dialog"
      closeOnOverlay={false}
      busy={Boolean(busy)}
      footer={mode === "form" ? (
        <>
          <button type="button" className="ui-button ui-button-secondary" onClick={onBack} disabled={Boolean(busy)}>
            取消
          </button>
          <button type="button" className="ui-button ui-button-primary" onClick={onSave} disabled={Boolean(busy)}>
            保存
          </button>
        </>
      ) : undefined}
    >
      <p className="dialog-hint">管理会话上下文压缩提示，生成后会复制到剪贴板。</p>
      {mode === "list" ? (
        <div className="compression-list-page">
          <div className="compression-list-toolbar">
            <div>
              <strong>压缩提示</strong>
              <span>{prompts.length} 个</span>
            </div>
            <button type="button" className="ui-button ui-button-primary" onClick={onNew} disabled={Boolean(busy)}>
              新增提示
            </button>
          </div>
          {toast && <div className={`compression-list-toast ${toast.tone}`}>{toast.message}</div>}
          <div className="compression-list-table">
            {busy && <div className="compression-empty">{busy}</div>}
            {!busy && prompts.length === 0 ? (
              <div className="compression-empty">暂无压缩提示。</div>
            ) : prompts.map((prompt) => (
              <article key={prompt.id} className="compression-list-row">
                <div className="compression-list-main">
                  <strong>{prompt.name}</strong>
                  <span>{compressionPromptPreview(prompt.content)}</span>
                </div>
                <span>{formatRelative(prompt.updatedAt)}</span>
                <div className="compression-card-actions">
                  <button type="button" className="ui-button ui-button-secondary" onClick={() => void onGenerate(prompt)} disabled={Boolean(busy)}>
                    生成
                  </button>
                  <button type="button" className="ui-button ui-button-secondary" onClick={() => onEdit(prompt)} disabled={Boolean(busy)}>
                    编辑
                  </button>
                  <button type="button" className="ui-button ui-button-danger" onClick={() => setDeleteCandidate(prompt)} disabled={Boolean(busy)}>
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="compression-editor">
          <label className="compression-form-field">
            <span><b>*</b>提示名称</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft("name", event.target.value)}
              placeholder="例如：可恢复工作状态摘要"
              autoFocus
            />
            {fieldErrors.name && <small>{fieldErrors.name}</small>}
          </label>
          <label className="compression-form-field">
            <span><b>*</b>提示内容</span>
            <textarea
              value={draft.content}
              onChange={(event) => updateDraft("content", event.target.value)}
              rows={18}
              spellCheck={false}
            />
            {fieldErrors.content && <small>{fieldErrors.content}</small>}
          </label>
          {(error || busy) && <div className={error ? "compression-error" : "compression-message"}>{error || busy}</div>}
        </div>
      )}
      {mode === "list" && error && <div className="compression-error">{error}</div>}
      {deleteCandidateExists && (
        <div className="compression-confirm-overlay" role="presentation">
          <section className="compression-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="compression-delete-title">
            <h3 id="compression-delete-title">删除压缩提示？</h3>
            <p>{deleteCandidate.name}</p>
            <div>
              <button type="button" className="ui-button ui-button-secondary" onClick={() => setDeleteCandidate(null)}>
                取消
              </button>
              <button
                type="button"
                className="ui-button ui-button-danger"
                onClick={() => {
                  onDelete(deleteCandidate.id);
                  setDeleteCandidate(null);
                }}
              >
                删除
              </button>
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
