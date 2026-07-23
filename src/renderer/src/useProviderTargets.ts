import { useCallback, useEffect, useRef, useState } from "react";
import type { AiProviderId, AiProviderSummary, AiTarget } from "./types";

type LoadTargetOptions = {
  showLoading?: boolean;
};

type UseProviderTargetsOptions = {
  setError: (message: string) => void;
  logPerformance: (label: string, durationMs: number, status?: string) => Promise<void>;
};

export function useProviderTargets({ setError, logPerformance }: UseProviderTargetsOptions) {
  const [providers, setProviders] = useState<AiProviderSummary[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId | "">("");
  const [targets, setTargets] = useState<AiTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const providerIdRef = useRef<AiProviderId | "">("");

  const applyTargets = useCallback((items: AiTarget[]) => {
    setTargets(items);
    setTargetId((current) => items.find((target) => target.id === current)?.id || items[0]?.id || "");
  }, []);

  const loadTargets = useCallback(async (nextProviderId: AiProviderId, _options: LoadTargetOptions = {}) => {
    setError("");
    const startedAt = performance.now();
    try {
      const items = await window.codexConsole.listTargets(nextProviderId);
      if (providerIdRef.current !== nextProviderId) return;
      applyTargets(items);
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt);
    } catch (loadError: any) {
      void logPerformance(`targets.fresh.loaded.${nextProviderId}`, performance.now() - startedAt, "error");
      if (providerIdRef.current === nextProviderId) setError(loadError?.message || "加载 AI 平台目标失败。");
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
        applyTargets(cachedTargets);
      }
    } catch {
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
      } catch (loadError: any) {
        setError(loadError?.message || "加载 AI 平台失败。");
      }
    };
    void loadProviders();
  }, [setError]);

  useEffect(() => {
    providerIdRef.current = providerId;
    applyTargets([]);
    if (providerId) void loadInitialTargets(providerId);
  }, [applyTargets, loadInitialTargets, providerId]);

  return {
    providers,
    providerId,
    setProviderId,
    targets,
    targetId,
    setTargetId,
    loadTargets
  };
}
