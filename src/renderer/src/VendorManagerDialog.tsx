import { useState } from "react";
import type { ChangeEvent } from "react";
import type { AiProviderId, AiTarget, ApiVendor, ApiVendorConfigTemplate } from "./types";
import {
  buildVendorDraft,
  renderVendorConfigPreview,
  toVendorConfigTemplate,
  visibleVendorConfigs,
  type ApiVendorDraft,
  type VendorFieldErrors,
  type VendorFieldName
} from "./vendorConfig";

// 供应商管理弹框：列表/表单两种模式，表单内按厂商展示配置文件预览并写回模板。从 App.tsx 抽出为独立组件。

export function VendorManagerDialog({
  vendors,
  draft,
  mode,
  busy,
  error,
  fieldErrors,
  message,
  toast,
  target,
  onDraftChange,
  onFieldErrorClear,
  onNew,
  onEdit,
  onProviderChange,
  onSave,
  onDelete,
  onEnable,
  onBack,
  onClose
}: {
  vendors: ApiVendor[];
  draft: ApiVendorDraft;
  mode: "list" | "form";
  busy: string;
  error: string;
  fieldErrors: VendorFieldErrors;
  message: string;
  toast: { message: string; tone: "success" | "error" } | null;
  target?: AiTarget;
  onDraftChange: (draft: ApiVendorDraft) => void;
  onFieldErrorClear: (field: VendorFieldName) => void;
  onNew: () => void;
  onEdit: (vendor: ApiVendor) => void;
  onProviderChange: (providerId: AiProviderId) => void;
  onSave: () => void;
  onDelete: (vendorId: string) => void;
  onEnable: (vendorId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [deleteCandidate, setDeleteCandidate] = useState<ApiVendor | null>(null);

  function updateDraft(patch: Partial<ApiVendorDraft>) {
    (["name", "apiBaseUrl", "apiKey"] as const).forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(patch, field)) onFieldErrorClear(field);
    });
    onDraftChange(buildVendorDraft({ ...draft, ...patch }));
  }

  function updateConfig(configId: string, patch: Partial<ApiVendorConfigTemplate>) {
    onDraftChange({
      ...draft,
      configs: draft.configs.map((config) => config.id === configId ? { ...config, ...patch } : config)
    });
  }

  const visibleConfigs = visibleVendorConfigs(draft);
  const deleteCandidateExists = deleteCandidate && vendors.some((vendor) => vendor.id === deleteCandidate.id);

  return (
    <div className="dialog-overlay" role="presentation">
      <section className="vendor-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="vendor-manager-title">
        <header>
          <div>
            <h2 id="vendor-manager-title">供应商管理</h2>
            <p>
              保存 API 供应商并按当前目标环境写入 CLI 配置文件。启用后，已打开的同协议终端会在下一次请求时切换。
              接入本地网关的终端仅使用本地令牌、不读取磁盘 Key；写入配置文件的真实 Key 作为未接入网关终端的 fallback。
            </p>
          </div>
          <button type="button" title="关闭" onClick={onClose} disabled={Boolean(busy)}>
            x
          </button>
        </header>
        {mode === "list" ? (
          <div className="vendor-list-page">
            <div className="vendor-list-toolbar">
              <div>
                <strong>历史供应商</strong>
                <span>{vendors.length} 个</span>
              </div>
              <button type="button" onClick={onNew} disabled={Boolean(busy)}>
                新增供应商
              </button>
            </div>
            {toast && <div className={`vendor-list-toast ${toast.tone}`}>{toast.message}</div>}
            <div className="vendor-list-table">
              {vendors.length === 0 ? (
                <div className="vendor-empty">暂无供应商。</div>
              ) : vendors.map((vendor) => (
                <article key={vendor.id} className="vendor-list-row">
                  <div className="vendor-list-main">
                    <strong>{vendor.name}</strong>
                    <span>{vendor.apiBaseUrl}</span>
                  </div>
                  <span>{providerLabel(vendor.providerId)}</span>
                  <div className="vendor-card-actions">
                    <button
                      type="button"
                      className={vendor.enabled ? "active" : ""}
                      onClick={() => onEnable(vendor.id)}
                      disabled={Boolean(busy) || vendor.enabled}
                    >
                      {vendor.enabled ? "已启用" : "启用"}
                    </button>
                    <button type="button" onClick={() => onEdit(vendor)} disabled={Boolean(busy)}>
                      编辑
                    </button>
                    <button type="button" className="danger" onClick={() => setDeleteCandidate(vendor)} disabled={Boolean(busy)}>
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {deleteCandidateExists && (
              <div className="vendor-confirm-overlay" role="presentation">
                <section className="vendor-confirm-dialog" role="alertdialog" aria-modal="true">
                  <h3>删除供应商</h3>
                  <p>确认删除供应商「{deleteCandidate.name}」？此操作不会还原已写入的 CLI 配置。</p>
                  <div>
                    <button type="button" className="secondary" onClick={() => setDeleteCandidate(null)} disabled={Boolean(busy)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        const vendorId = deleteCandidate.id;
                        setDeleteCandidate(null);
                        onDelete(vendorId);
                      }}
                      disabled={Boolean(busy)}
                    >
                      删除
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        ) : (
          <div className="vendor-editor">
            <div className="vendor-target-summary">
              <span>目标环境</span>
              <strong>{target?.label || "当前运行环境"}</strong>
              <small>{target?.kind === "wsl" ? "写入 WSL 内配置" : "写入本机用户配置"}</small>
            </div>
            <div className="vendor-provider-picker">
              <span>模型厂商</span>
              <div>
                {(["codex", "claude", "gemini"] as AiProviderId[]).map((nextProviderId) => (
                  <button
                    key={nextProviderId}
                    type="button"
                    className={draft.providerId === nextProviderId ? "active" : ""}
                    onClick={() => onProviderChange(nextProviderId)}
                  >
                    {providerLabel(nextProviderId)}
                  </button>
                ))}
              </div>
            </div>
            <div className="vendor-form-grid">
              <label className="required">
                <span>供应商名称</span>
                <input
                  value={draft.name}
                  aria-invalid={Boolean(fieldErrors.name)}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
                {fieldErrors.name && <small>{fieldErrors.name}</small>}
              </label>
              <label className="required">
                <span>API 请求地址</span>
                <input
                  value={draft.apiBaseUrl}
                  aria-invalid={Boolean(fieldErrors.apiBaseUrl)}
                  onChange={(event) => updateDraft({ apiBaseUrl: event.target.value })}
                />
                {fieldErrors.apiBaseUrl && <small>{fieldErrors.apiBaseUrl}</small>}
              </label>
              <label className="required">
                <span>API Key</span>
                <input
                  value={draft.apiKey}
                  type="password"
                  placeholder={draft.id ? "留空以保留现有 API Key" : "输入 API Key"}
                  aria-invalid={Boolean(fieldErrors.apiKey)}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                />
                {fieldErrors.apiKey && <small>{fieldErrors.apiKey}</small>}
              </label>
            </div>
            <div className="vendor-config-heading">
              <strong>配置文件：</strong>
              <label>
                <input
                  type="checkbox"
                  checked={draft.writeCommonConfig === true}
                  onChange={(event) => updateDraft({ writeCommonConfig: event.target.checked })}
                />
                <span>写入通用配置</span>
              </label>
            </div>
            <div className="vendor-config-list">
              {visibleConfigs.length === 0 ? (
                <div className="vendor-config-empty">当前只保存供应商信息，不写入通用配置文件。</div>
              ) : visibleConfigs.map((config) => (
                <div key={config.id || `${config.providerId}-${config.targetPath}`} className="vendor-config-editor">
                  <h3>{configFileName(config.targetPath)}</h3>
                  <label>
                    <span>配置文件预览</span>
                    <VendorConfigPreviewEditor
                      value={renderVendorConfigPreview(config, draft)}
                      onChange={(event) => updateConfig(config.id!, { content: toVendorConfigTemplate(event.target.value, draft) })}
                    />
                  </label>
                </div>
              ))}
            </div>
          </div>
        )}
        {(busy || error || message) && (
          <section className="vendor-manager-message" aria-live="polite">
            {busy && <strong>{busy}</strong>}
            {message && <span>{message}</span>}
            {error && <pre>{error}</pre>}
          </section>
        )}
        <footer>
          {mode === "form" ? (
            <>
              <button type="button" className="secondary" onClick={onBack} disabled={Boolean(busy)}>
                返回
              </button>
              <button type="button" onClick={onSave} disabled={Boolean(busy)}>
                保存
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={onClose} disabled={Boolean(busy)}>
              关闭
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function VendorConfigPreviewEditor({
  value,
  onChange
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  const lineCount = Math.max(1, value.split(/\r\n|\r|\n/).length);
  const rows = Math.max(3, lineCount);
  return (
    <div className="vendor-config-preview-editor">
      <pre aria-hidden="true">{Array.from({ length: lineCount }, (_item, index) => index + 1).join("\n")}</pre>
      <textarea
        value={value}
        rows={rows}
        wrap="off"
        spellCheck={false}
        onChange={onChange}
      />
    </div>
  );
}

function providerLabel(providerId: AiProviderId) {
  if (providerId === "gemini") return "Gemini";
  if (providerId === "claude") return "Claude";
  return "Codex";
}

function configFileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || filePath;
}
