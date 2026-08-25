import { useEffect, useState } from "react";
import type { AiProviderId, AiTarget, ApiVendor } from "./types";
import {
  buildVendorConfigTemplateFromExisting,
  buildVendorDraft,
  createEmptyVendorDraft,
  prepareVendorDraftForSave,
  shouldApplyVendorConfigAfterSave,
  validateVendorDraft,
  vendorToDraft,
  type ApiVendorDraft,
  type VendorFieldErrors
} from "./vendorConfig";

type VendorToast = { message: string; tone: "success" | "error" } | null;

// 供应商管理的全部状态与副作用，从 App.tsx 抽出为自定义 Hook。
// 仅依赖外部的 selectedTarget / targetId / providerId 三个值。
export function useVendors({
  selectedTarget,
  targetId,
  providerId,
  activeTerminalId
}: {
  selectedTarget: AiTarget | undefined;
  targetId: string;
  providerId: AiProviderId | "";
  activeTerminalId?: string;
}) {
  const [vendorManagerOpen, setVendorManagerOpen] = useState(false);
  const [vendorManagerMode, setVendorManagerMode] = useState<"list" | "form">("list");
  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [vendorDraft, setVendorDraft] = useState<ApiVendorDraft>(() => createEmptyVendorDraft());
  const [vendorBusy, setVendorBusy] = useState("");
  const [vendorError, setVendorError] = useState("");
  const [vendorFieldErrors, setVendorFieldErrors] = useState<VendorFieldErrors>({});
  const [vendorMessage, setVendorMessage] = useState("");
  const [vendorToast, setVendorToast] = useState<VendorToast>(null);

  useEffect(() => {
    if (!vendorToast) return;
    const timer = window.setTimeout(() => setVendorToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [vendorToast]);

  async function openVendorManager() {
    setVendorManagerOpen(true);
    setVendorManagerMode("list");
    setVendorError("");
    setVendorFieldErrors({});
    setVendorMessage("");
    await loadApiVendors();
  }

  async function loadApiVendors() {
    setVendorBusy("正在加载供应商...");
    setVendorError("");
    try {
      const list = await window.codexConsole.listApiVendors(selectedTarget?.id || targetId);
      setVendors(list);
      setVendorDraft((current) => current.id ? current : list[0] ? vendorToDraft(list[0]) : current);
    } catch (vendorLoadError: any) {
      setVendorError(vendorLoadError?.message || "加载供应商失败。");
    } finally {
      setVendorBusy("");
    }
  }

  async function saveVendorDraft() {
    const fieldErrors = validateVendorDraft(vendorDraft, vendors);
    if (Object.keys(fieldErrors).length > 0) {
      setVendorFieldErrors(fieldErrors);
      setVendorError("");
      setVendorMessage("");
      return;
    }
    setVendorBusy("正在保存供应商...");
    setVendorError("");
    setVendorFieldErrors({});
    setVendorMessage("");
    try {
      const wasEnabled = Boolean(vendorDraft.id && vendors.some((vendor) => vendor.id === vendorDraft.id && vendor.enabled));
      const shouldApplyConfig = shouldApplyVendorConfigAfterSave(vendorDraft, vendors);
      const saved = await window.codexConsole.saveApiVendor(prepareVendorDraftForSave(vendorDraft));
      let switched = false;
      let switchReason: string | undefined;
      if (shouldApplyConfig) {
        const result = await window.codexConsole.enableApiVendor({
          vendorId: saved.id,
          targetId: selectedTarget?.id || targetId || undefined,
          terminalId: activeTerminalId
        });
        switched = result.switched === true;
        switchReason = result.switchReason;
      }
      const list = await window.codexConsole.listApiVendors(selectedTarget?.id || targetId);
      setVendors(list);
      setVendorDraft(vendorToDraft(list.find((vendor) => vendor.id === saved.id) || saved));
      setVendorManagerMode("list");
      const encryptionAvailable = await window.codexConsole.isApiKeyEncryptionAvailable().catch(() => true);
      const baseMessage = wasEnabled
        ? switched
          ? "供应商已保存，当前终端路由已切换；已发出的请求按原供应商处理，后续请求使用新供应商。"
          : switchReason === "gateway-not-active"
            ? "供应商已保存；当前终端未接入本地 Gateway，请关闭并重新打开一次，之后可直接切换。"
            : "供应商已保存并更新当前配置。"
        : shouldApplyConfig ? "供应商已保存并启用。" : "供应商已保存。";
      setVendorMessage(
        encryptionAvailable
          ? baseMessage
          : `${baseMessage} ⚠ 当前系统不可用安全存储，API Key 以明文形式保存在本地，请谨慎使用。`
      );
    } catch (vendorSaveError: any) {
      setVendorError(vendorSaveError?.message || "保存供应商失败。");
    } finally {
      setVendorBusy("");
    }
  }

  async function editVendorDraft(vendor?: ApiVendor) {
    setVendorMessage("");
    setVendorError("");
    setVendorFieldErrors({});
    const currentProviderId = selectedTarget?.provider || providerId || "codex";
    const base = vendor
      ? vendorToDraft(vendor)
      : buildVendorDraft({
        providerId: currentProviderId,
        name: "",
        apiKey: "",
        apiBaseUrl: "",
        writeCommonConfig: false,
        configs: []
      });
    setVendorDraft(base);
    setVendorManagerMode("form");
    await loadVendorConfigPreview(base);
  }

  async function changeVendorDraftProvider(nextProviderId: AiProviderId) {
    const nextDraft = buildVendorDraft({
      ...vendorDraft,
      providerId: nextProviderId,
      configs: []
    });
    setVendorDraft(nextDraft);
    await loadVendorConfigPreview(nextDraft);
  }

  async function loadVendorConfigPreview(sourceDraft: ApiVendorDraft) {
    setVendorError("");
    try {
      const result = await window.codexConsole.readApiVendorConfigs({
        targetId: selectedTarget?.id || targetId || undefined,
        paths: sourceDraft.configs.map((config) => config.targetPath)
      });
      const files = new Map(result.files.map((file) => [file.path, file.content]));
      setVendorDraft((current) => {
        if (current.id !== sourceDraft.id || current.providerId !== sourceDraft.providerId) return current;
        return {
          ...current,
          configs: current.configs.map((config) => ({
            ...config,
            content: buildVendorConfigTemplateFromExisting(config, files.get(config.targetPath) || "", current)
          }))
        };
      });
    } catch (previewError: any) {
      setVendorError(previewError?.message || "读取本地配置失败。");
    }
  }

  async function deleteVendorById(vendorId: string) {
    setVendorBusy("正在删除供应商...");
    setVendorError("");
    setVendorMessage("");
    setVendorToast(null);
    try {
      await window.codexConsole.deleteApiVendor(vendorId);
      const list = await window.codexConsole.listApiVendors(selectedTarget?.id || targetId);
      setVendors(list);
      setVendorDraft(list[0] ? vendorToDraft(list[0]) : createEmptyVendorDraft());
      setVendorManagerMode("list");
      setVendorToast({ message: "供应商已删除。", tone: "success" });
    } catch (vendorDeleteError: any) {
      setVendorToast({ message: vendorDeleteError?.message || "删除供应商失败。", tone: "error" });
    } finally {
      setVendorBusy("");
    }
  }

  async function enableVendorById(vendorId: string) {
    setVendorBusy("正在启用供应商...");
    setVendorError("");
    setVendorMessage("");
    try {
      const result = await window.codexConsole.enableApiVendor({
        vendorId,
        targetId: selectedTarget?.id || targetId || undefined,
        terminalId: activeTerminalId
      });
      const switched = result.switched === true;
      await loadApiVendors();
      setVendorMessage(
        switched
          ? `供应商已启用，写入 ${result.written.length} 个配置文件；当前终端路由已切换，后续请求使用新供应商。已发出的请求按原供应商处理。`
          : result.switchReason === "gateway-not-active"
            ? `供应商已启用，写入 ${result.written.length} 个配置文件；当前终端未接入本地 Gateway，请关闭并重新打开一次，之后可直接切换。`
            : `供应商已启用，写入 ${result.written.length} 个配置文件；新终端将使用该供应商。`
      );
    } catch (vendorEnableError: any) {
      setVendorError(vendorEnableError?.message || "启用供应商失败。");
    } finally {
      setVendorBusy("");
    }
  }

  return {
    vendorManagerOpen,
    setVendorManagerOpen,
    vendorManagerMode,
    setVendorManagerMode,
    vendors,
    vendorDraft,
    setVendorDraft,
    vendorBusy,
    vendorError,
    vendorFieldErrors,
    setVendorFieldErrors,
    vendorMessage,
    vendorToast,
    openVendorManager,
    editVendorDraft,
    changeVendorDraftProvider,
    saveVendorDraft,
    deleteVendorById,
    enableVendorById
  };
}
