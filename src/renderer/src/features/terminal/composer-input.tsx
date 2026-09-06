import { useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from "react";
import {
  Archive,
  ArrowUp,
  ChevronDown,
  Copy,
  File,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Layers3,
  Minus,
  Paperclip,
  Plus,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { VendorModel } from "../../types";
import { getProviderIdFromTargetId } from "../../../../shared/target-ids";
import { useVendorData } from "../vendors/vendor-context";

export type ComposerAttachment = {
  id: string;
  kind: "image" | "file" | "directory";
  name: string;
  path: string;
  type?: string;
  size?: number;
  dataUrl?: string;
};

export type ComposerSubmitPayload = {
  text: string;
  attachments: ComposerAttachment[];
  modelId?: string;
};

type ComposerInputProps = {
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: (payload: ComposerSubmitPayload) => void;
  onInterrupt: () => void;
  canSubmit: boolean;
  height: number;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onMouseDown: () => void;
  onModelSelect?: (modelId: string) => void;
  modelSelectionSupported?: boolean;
  targetId: string;
  placeholder?: string;
};

type ImagePreview = {
  attachment: ComposerAttachment;
  zoom: number;
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export function ComposerInput({
  composerRef,
  text,
  onTextChange,
  onSubmit,
  onInterrupt,
  canSubmit,
  height,
  onResizeStart,
  onFocus,
  onMouseDown,
  onModelSelect,
  modelSelectionSupported = true,
  targetId,
  placeholder = "按 ALT + ENTER 换行"
}: ComposerInputProps) {
  const vendors = useVendorData();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [models, setModels] = useState<VendorModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // 供应商属于具体 CLI 协议，不能从全局列表直接取第一个启用项，
  // 否则 Claude/Gemini 会误用 Codex 供应商的模型接口。
  const targetProvider = getProviderIdFromTargetId(targetId);
  const providerVendors = vendors.filter((vendor) => vendor.providerId === targetProvider);
  const enabledVendor = providerVendors.find((vendor) => vendor.enabled) || providerVendors[0];
  const isQoderTarget = targetProvider === "qoder";

  useEffect(() => {
    if (!isQoderTarget && !enabledVendor) {
      setModels([]);
      setModelsError("");
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelsError("");
    setModels([]);
    setSelectedModelId("");
    const request = isQoderTarget
      ? window.codexConsole.listModels(targetId)
      : window.codexConsole.listVendorModels(enabledVendor!.id);
    request
      .then((result) => {
        if (!cancelled) {
          setModels(result);
          if (result.length > 0) {
            setSelectedModelId(result[0].id);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setModelsError("模型列表读取失败，请检查供应商地址和 API Key。");
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, isQoderTarget, enabledVendor?.id]);

  useEffect(() => {
    if (!modelDropdownOpen) return;
    function onDocMouseDown(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [modelDropdownOpen]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!attachMenuRef.current?.contains(event.target as Node)) setAttachMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [attachMenuOpen]);

  function handleAttachClick() {
    setAttachMenuOpen((open) => !open);
  }

  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    addFiles(Array.from(files));
    event.target.value = "";
  }

  function addFiles(files: File[]) {
    const newAttachments: ComposerAttachment[] = [];
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      if (isImage && file.size > MAX_IMAGE_SIZE) continue;
      const attachment: ComposerAttachment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: isImage ? "image" : "file",
        name: file.name,
        path: (file as File & { path?: string }).path || file.name,
        type: file.type,
        size: file.size
      };
      if (isImage) {
        const reader = new FileReader();
        reader.onload = () => {
          attachment.dataUrl = reader.result as string;
          setAttachments((prev) => [...prev, { ...attachment }]);
        };
        reader.readAsDataURL(file);
      } else {
        newAttachments.push(attachment);
      }
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  }

  async function addDirectory() {
    setAttachMenuOpen(false);
    // 文件夹必须由主进程选择，确保拿到真实路径并能传给对应 CLI。
    const result = await window.codexConsole.chooseDirectory().catch(() => ({ filePath: undefined }));
    const filePath = result.filePath;
    if (!filePath) return;
    const name = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
    setAttachments((prev) => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "directory",
      name,
      path: filePath
    }]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handleDragOver(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  }

  function handleDrop(event: ReactDragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const files = event.dataTransfer.files;
    if (files.length > 0) addFiles(Array.from(files));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      const target = event.currentTarget;
      if (target.selectionStart === target.selectionEnd) {
        event.preventDefault();
        onInterrupt();
      }
      return;
    }
    if (event.key !== "Enter") return;
    if (event.altKey || event.shiftKey) {
      event.preventDefault();
      insertNewline(event.currentTarget);
      return;
    }
    event.preventDefault();
    handleSubmit();
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  }

  function insertNewline(element: HTMLTextAreaElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onTextChange(`${text.slice(0, start)}\n${text.slice(end)}`);
    window.setTimeout(() => {
      element.selectionStart = start + 1;
      element.selectionEnd = start + 1;
      element.scrollTop = element.scrollHeight;
      element.focus();
    }, 0);
  }

  function handleSubmit() {
    if (!canSubmit && attachments.length === 0) return;
    const payload: ComposerSubmitPayload = {
      text: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, ""),
      attachments: [...attachments],
      modelId: selectedModelId || undefined
    };
    setAttachments([]);
    onSubmit(payload);
  }

  function openImagePreview(attachment: ComposerAttachment) {
    setImagePreview({ attachment, zoom: 1 });
  }

  function closeImagePreview() {
    setImagePreview(null);
  }

  function zoomImagePreview(delta: number) {
    setImagePreview((prev) => prev ? { ...prev, zoom: Math.max(0.25, Math.min(3, prev.zoom + delta)) } : null);
  }

  function copyImagePreview() {
    if (!imagePreview?.attachment.dataUrl) return;
    void navigator.clipboard.write([
      new ClipboardItem({ "image/png": dataURLtoBlob(imagePreview.attachment.dataUrl) })
    ]);
  }

  function dataURLtoBlob(dataUrl: string): Blob {
    const parts = dataUrl.split(",");
    const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
    const binary = atob(parts[1]);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
    return new Blob([array], { type: mime });
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getFileIcon(type?: string): LucideIcon {
    if (!type) return File;
    if (type.startsWith("image/")) return ImageIcon;
    if (type.includes("pdf")) return FileText;
    if (type.includes("text") || type.includes("json") || type.includes("javascript") || type.includes("typescript")) return FileCode2;
    if (type.includes("zip") || type.includes("archive") || type.includes("compressed")) return Archive;
    return File;
  }

  function getFileExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
  }

  const selectedModel = models.find((m) => m.id === selectedModelId);
  const displayModelName = selectedModel?.id || (modelsLoading ? "加载中..." : "Auto");

  return (
    <div
      className={`terminal-composer ${dragging ? "dragging" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="terminal-composer-resize"
        role="separator"
        aria-orientation="horizontal"
        title="拖动调整输入框高度"
        onMouseDown={onResizeStart}
      />

      {dragging && (
        <div className="composer-drag-overlay">
          <span>松开以添加文件或文件夹</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <div key={attachment.id} className={`composer-attachment-card ${attachment.kind}`}>
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label="移除附件"
                onClick={() => removeAttachment(attachment.id)}
              >
                <X aria-hidden="true" size={14} strokeWidth={2.2} />
              </button>
              {attachment.kind === "image" && attachment.dataUrl ? (
                <button
                  type="button"
                  className="composer-attachment-thumb"
                  onClick={() => openImagePreview(attachment)}
                  title={attachment.name}
                >
                  <img src={attachment.dataUrl} alt={attachment.name} />
                </button>
              ) : (
                <div className="composer-attachment-file" title={attachment.path}>
                  <span className="composer-attachment-icon" aria-hidden="true">
                    {(() => {
                      const Icon = getFileIcon(attachment.type);
                      return <Icon size={20} strokeWidth={1.8} />;
                    })()}
                  </span>
                  <div className="composer-attachment-info">
                    <span className="composer-attachment-name">{attachment.name}</span>
                    <span className="composer-attachment-type">
                      {attachment.kind === "directory" ? "文件夹" : getFileExtension(attachment.name)}
                      {attachment.size ? ` · ${formatFileSize(attachment.size)}` : ""}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="composer-input-row">
        <textarea
          ref={composerRef}
          value={text}
          style={{ height: `${height}px` }}
          spellCheck={false}
          placeholder={placeholder}
          onFocus={onFocus}
          onMouseDown={onMouseDown}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <button
          type="button"
          className="composer-send-btn"
          onClick={handleSubmit}
          disabled={!canSubmit && attachments.length === 0}
          title="发送 (Enter)"
          aria-label="发送"
        >
          <ArrowUp aria-hidden="true" size={18} strokeWidth={2.4} />
        </button>
      </div>

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
          <div className="composer-attach-menu" ref={attachMenuRef}>
            <button
              type="button"
              className="composer-toolbar-btn composer-attach-btn"
              title="添加图片、文件或文件夹"
              aria-label="添加图片、文件或文件夹"
              aria-expanded={attachMenuOpen}
              onClick={handleAttachClick}
            >
              <Paperclip aria-hidden="true" size={17} strokeWidth={2} />
            </button>
            {attachMenuOpen && (
              <div className="composer-attach-dropdown" role="menu">
                <button type="button" role="menuitem" onClick={() => { setAttachMenuOpen(false); fileInputRef.current?.click(); }}>
                  <span aria-hidden="true">▧</span><span>添加文件</span>
                </button>
                <button type="button" role="menuitem" onClick={() => void addDirectory()}>
                  <span aria-hidden="true">□</span><span>添加文件夹</span>
                </button>
              </div>
            )}
          </div>

          {modelSelectionSupported && (
            <div className="composer-model-selector" ref={dropdownRef}>
              <button
                type="button"
                className="composer-toolbar-btn composer-model-btn"
                onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              >
                <Layers3 aria-hidden="true" size={15} strokeWidth={1.9} />
                <span>{displayModelName}</span>
                <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
              </button>
              {modelDropdownOpen && (
                <div className="composer-model-dropdown">
                  {models.length === 0 && !modelsLoading && (
                    <div className="composer-model-empty">{modelsError || "暂无可用模型"}</div>
                  )}
                  {modelsLoading && (
                    <div className="composer-model-empty">正在加载模型...</div>
                  )}
                  {models.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={`composer-model-option ${selectedModelId === model.id ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedModelId(model.id);
                        onModelSelect?.(model.id);
                        setModelDropdownOpen(false);
                      }}
                    >
                      <div className="composer-model-option-header">
                        <span className="composer-model-option-name">{model.id}</span>
                        {model.pricingMultiplier != null && (
                          <span className="composer-model-option-price">{model.pricingMultiplier}×</span>
                        )}
                      </div>
                      {model.description && (
                        <div className="composer-model-option-desc">{model.description}</div>
                      )}
                      {model.tags && model.tags.length > 0 && (
                        <div className="composer-model-option-tags">
                          {model.tags.map((tag) => (
                            <span key={tag} className="composer-model-tag">{tag}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {imagePreview && (
        <div className="composer-image-overlay" role="presentation" onClick={closeImagePreview}>
          <div className="composer-image-modal" onClick={(e) => e.stopPropagation()}>
            <div className="composer-image-actions">
              <button type="button" className="composer-image-action-btn" onClick={copyImagePreview} title="复制">
                <Copy aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              <button type="button" className="composer-image-action-btn" onClick={closeImagePreview} title="关闭">
                <X aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </div>
            <div className="composer-image-container">
              <img
                src={imagePreview.attachment.dataUrl}
                alt={imagePreview.attachment.name}
                style={{ transform: `scale(${imagePreview.zoom})` }}
              />
            </div>
            <div className="composer-image-footer">
              <span className="composer-image-name">{imagePreview.attachment.name}</span>
              <div className="composer-image-zoom">
                <button type="button" aria-label="缩小预览" title="缩小预览" onClick={() => zoomImagePreview(-0.1)}><Minus aria-hidden="true" size={15} /></button>
                <span>{Math.round(imagePreview.zoom * 100)}%</span>
                <button type="button" aria-label="放大预览" title="放大预览" onClick={() => zoomImagePreview(0.1)}><Plus aria-hidden="true" size={15} /></button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
