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

export function useProviderTargets({ setError, logPerformance }: UseProviderTargetsOptions) {
  const [providers, setProviders] = useState<AiProviderSummary[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId | "">("");
  const [targets, setTargets] = useState<AiTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const providerIdRef = useRef<AiProviderId | "">("");
  const pendingTargetIdRef = useRef("");

  const applyTargets = useCallback((items: AiTarget[]) => {
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
      applyTargets(items);
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
        applyTargets(cachedTargets);
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

  return {
    providers,
    providerId,
    setProviderId,
    targets,
    targetId,
    setTargetId,
    loadTargets,
    selectKnownTarget
  };
}
