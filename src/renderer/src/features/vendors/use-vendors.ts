import { useEffect, useState } from "react";
import type { AiProviderId, AiTarget, ApiVendor } from "../../types";
import { captureError } from "../../hooks/error-utils";
import {
  buildVendorConfigTemplateFromExisting,
  buildVendorDraft,
  createEmptyVendorDraft,
  prepareVendorDraftForSave,
  validateVendorDraft,
  vendorToDraft,
  type ApiVendorDraft,
  type VendorFieldErrors
} from "./vendor-config";

type VendorToast = { message: string; tone: "success" | "error" } | null;

// 供应商管理的全部状态与副作用，从 App.tsx 抽出为自定义 Hook。
// 仅依赖外部的 selectedTarget / targetId / providerId 三个值。
export function useVendors({
  selectedTarget,
  targetId,
  providerId,
}: {
  selectedTarget: AiTarget | undefined;
  targetId: string;
  providerId: AiProviderId | "";
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
  const [refreshingVendorIds, setRefreshingVendorIds] = useState<string[]>([]);
  const [refreshingAllBalances, setRefreshingAllBalances] = useState(false);

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

  async function loadApiVendors(showBusy = true) {
    if (showBusy) setVendorBusy("正在加载供应商...");
    setVendorError("");
    try {
      const list = await window.codexConsole.listApiVendors(selectedTarget?.id || targetId);
      setVendors(list);
      setVendorDraft((current) => current.id ? current : list[0] ? vendorToDraft(list[0]) : current);
    } catch (error: unknown) {
      setVendorError(captureError(error, "loadVendor"));
    } finally {
      if (showBusy) setVendorBusy("");
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
      const saved = await window.codexConsole.saveApiVendor(prepareVendorDraftForSave(vendorDraft));
      const list = await window.codexConsole.listApiVendors(selectedTarget?.id || targetId);
      setVendors(list);
      setVendorDraft(vendorToDraft(list.find((vendor) => vendor.id === saved.id) || saved));
      setVendorManagerMode("list");
      const baseMessage = "供应商已保存。候选池状态和费率配置已立即生效。";
      setVendorMessage(baseMessage);
    } catch (error: unknown) {
      setVendorError(captureError(error, "saveVendor"));
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
        pricing: {},
        enabled: true,
        sort: vendors.reduce((max, item) => Math.max(max, item.sort), 0) + 1,
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
    // 新建供应商没有现成文件可预览，避免打开表单时无意义地调用 WSL。
    if (!sourceDraft.id) return;
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
    } catch (error: unknown) {
      setVendorError(captureError(error, "previewConfig"));
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
    } catch (error: unknown) {
      setVendorToast({ message: captureError(error, "deleteVendor"), tone: "error" });
    } finally {
      setVendorBusy("");
    }
  }

  async function setVendorEnabledById(vendorId: string, enabled: boolean) {
    setVendorError("");
    try {
      await window.codexConsole.setApiVendorEnabled(vendorId, enabled);
      await loadApiVendors(false);
    } catch (error: unknown) {
      setVendorError(captureError(error, "setVendorEnabled"));
    }
  }

  async function refreshVendorBalanceById(vendorId: string) {
    if (refreshingAllBalances || refreshingVendorIds.includes(vendorId)) return;
    setVendorError("");
    setRefreshingVendorIds((current) => [...current, vendorId]);
    setVendors((current) => current.map((vendor) => vendor.id === vendorId
      ? { ...vendor, balanceStatus: "loading", balanceError: undefined }
      : vendor));
    try {
      const result = await window.codexConsole.refreshVendorBalance(vendorId);
      await loadApiVendors(false);
      setVendorMessage(result.ok ? "供应商余额已更新。" : `余额刷新失败：${result.message || "未知错误"}`);
    } catch (error: unknown) {
      setVendorError(captureError(error, "refreshBalance"));
    } finally {
      setRefreshingVendorIds((current) => current.filter((id) => id !== vendorId));
    }
  }

  async function refreshAllVendorBalances() {
    if (refreshingAllBalances || refreshingVendorIds.length > 0) return;
    setVendorError("");
    setRefreshingAllBalances(true);
    setVendors((current) => current.map((vendor) => ({ ...vendor, balanceStatus: "loading", balanceError: undefined })));
    try {
      const result = await window.codexConsole.refreshVendorBalances();
      await loadApiVendors(false);
      setVendorMessage(`余额刷新完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个。`);
    } catch (error: unknown) {
      setVendorError(captureError(error, "refreshBalances"));
    } finally {
      setRefreshingAllBalances(false);
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
    loadApiVendors,
    openVendorManager,
    editVendorDraft,
    changeVendorDraftProvider,
    saveVendorDraft,
    deleteVendorById,
    setVendorEnabledById,
    refreshVendorBalanceById,
    refreshAllVendorBalances,
    refreshingVendorIds,
    refreshingAllBalances
  };
}
