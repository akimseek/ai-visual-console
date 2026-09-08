import { useCallback, useEffect, useRef, useState } from "react";
import type { AiProviderId, AiProviderSummary, AiTarget } from "../types";
import { captureError } from "./error-utils";

type LoadTargetOptions = {
  showLoading?: boolean;
};

type UseProviderTargetsOptions = {
  setError: (message: string) => void;
  logPerformance: (label: string, durationMs: number, status?: string) => Promise<void>;
};

export function mergeKnownTarget(items: AiTarget[], target: AiTarget) {
  const index = items.findIndex((item) => item.id === target.id);
  if (index === -1) return [...items, target];
  return items.map((item) => (item.id === target.id ? target : item));
}

export function useProviderTargets({ setError, logPerformance }: UseProviderTargetsOptions) {
  const [providers, setProviders] = useState<AiProviderSummary[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId | "">("");
  const [targets, setTargets] = useState<AiTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const providerIdRef = useRef<AiProviderId | "">("");
  const pendingTargetIdRef = useRef("");
  const targetsByProviderRef = useRef<Partial<Record<AiProviderId, AiTarget[]>>>({});
  const skipInitialLoadForProviderRef = useRef<AiProviderId | "">("");

  const applyTargets = useCallback((items: AiTarget[], nextProviderId = providerIdRef.current) => {
    if (nextProviderId) targetsByProviderRef.current[nextProviderId] = items;
    setTargets(items);
    setTargetId((current) => {
      const pendingTargetId = pendingTargetIdRef.current;
      const nextTargetId = items.find((target) => target.id === pendingTargetId)?.id
        || items.find((target) => target.id === current)?.id
        || items[0]?.id
        || "";
      if (nextTargetId && nextTargetId === pendingTargetId) pendingTargetIdRef.current = "";
      return nextTargetId;
    });
  }, []);

  const loadTargets = useCallback(async (nextProviderId: AiProviderId, _options: LoadTargetOptions = {}) => {
    setError("");
    const startedAt = performance.now();
    try {
      const items = await window.codexConsole.listTargets(nextProviderId);
      if (providerIdRef.current !== nextProviderId) return;
      applyTargets(items, nextProviderId);
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt);
    } catch (loadError) {
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt, "error");
      if (providerIdRef.current === nextProviderId) {
        setError(captureError(loadError, `loadTargets:${nextProviderId}`, "加载 AI 平台目标失败。"));
      }
    }
  }, [applyTargets, logPerformance, setError]);

  const loadInitialTargets = useCallback(async (nextProviderId: AiProviderId) => {
    setError("");
    let hasCachedTargets = false;
    const cachedStartedAt = performance.now();

    try {
      const cachedTargets = await window.codexConsole.listCachedTargets(nextProviderId);
      void logPerformance(`targets.cached.loaded.${nextProviderId}`, performance.now() - cachedStartedAt);
      if (cachedTargets.length > 0) {
        if (providerIdRef.current !== nextProviderId) return;
        hasCachedTargets = true;
        applyTargets(cachedTargets, nextProviderId);
      }
    } catch (error) {
      captureError(error, `loadCachedTargets:${nextProviderId}`);
      void logPerformance(`targets.cached.loaded.${nextProviderId}`, performance.now() - cachedStartedAt, "error");
    }

    if (hasCachedTargets) {
      window.setTimeout(() => {
        void loadTargets(nextProviderId, { showLoading: false });
      }, 1500);
      return;
    }

    await loadTargets(nextProviderId, { showLoading: true });
  }, [applyTargets, loadTargets, logPerformance, setError]);

  useEffect(() => {
    const loadProviders = async () => {
      setError("");
      try {
        setProviders(await window.codexConsole.listProviders());
      } catch (loadError) {
        setError(captureError(loadError, "loadProviders", "加载 AI 平台失败。"));
      }
    };
    void loadProviders();
  }, [setError]);

  useEffect(() => {
    providerIdRef.current = providerId;
    if (skipInitialLoadForProviderRef.current === providerId) {
      skipInitialLoadForProviderRef.current = "";
      return;
    }
    if (!pendingTargetIdRef.current) applyTargets([]);
    if (providerId) void loadInitialTargets(providerId);
  }, [applyTargets, loadInitialTargets, providerId]);

  const selectKnownTarget = useCallback((target: AiTarget) => {
    pendingTargetIdRef.current = target.id;
    providerIdRef.current = target.provider;
    setProviderId(target.provider);
    setTargets([target]);
    setTargetId(target.id);
  }, []);

  // 终端标签切换只能使用标签已有的目标快照。此路径刻意不读取缓存、
  // 不探测 CLI/WSL，也不安排延迟刷新；显式刷新仍走 loadTargets。
  const syncTerminalTabTarget = useCallback((target: AiTarget) => {
    const providerChanged = providerIdRef.current !== target.provider;
    const nextTargets = mergeKnownTarget(targetsByProviderRef.current[target.provider] || [], target);
    targetsByProviderRef.current[target.provider] = nextTargets;
    pendingTargetIdRef.current = "";
    if (providerChanged) skipInitialLoadForProviderRef.current = target.provider;
    providerIdRef.current = target.provider;
    setProviderId(target.provider);
    setTargets(nextTargets);
    setTargetId(target.id);
  }, []);

  return {
    providers,
    providerId,
    setProviderId,
    targets,
    targetId,
    setTargetId,
    loadTargets,
    selectKnownTarget,
    syncTerminalTabTarget
  };
}
