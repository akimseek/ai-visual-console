import { useEffect, useState } from "react";
import type { GatewayExternalApiStatus, GatewayPortStatus } from "../../types";
import { captureError } from "../../hooks/error-utils";
import type { NoticeState } from "../../hooks/use-app-notice";

type SetNotice = (message: string, action?: { label: string; onClick: () => void }, tone?: NoticeState["tone"]) => void;

// 网关端口/熔断设置弹框：草稿校验、保存与状态读取都收敛在此，App 只负责渲染。
export function useGatewayPortDialog({ setNotice }: { setNotice: SetNotice }) {
  const [open, setOpen] = useState(false);
  const [portDraft, setPortDraft] = useState("0");
  const [failureThresholdDraft, setFailureThresholdDraft] = useState("1");
  const [circuitFailureThresholdDraft, setCircuitFailureThresholdDraft] = useState("3");
  const [circuitDurationDraft, setCircuitDurationDraft] = useState("60");
  const [status, setStatus] = useState<GatewayPortStatus | null>(null);
  const [externalApiStatus, setExternalApiStatus] = useState<GatewayExternalApiStatus | null>(null);
  const [externalApiToken, setExternalApiToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.codexConsole.getGatewayPort()
      .then(setStatus)
      .catch((loadError: unknown) => setError(captureError(loadError, "getGatewayPort", "读取 Gateway 状态失败。")));
  }, []);

  async function openGatewayPortDialog() {
    setError("");
    try {
      const [next, externalApi] = await Promise.all([
        window.codexConsole.getGatewayPort(),
        window.codexConsole.getGatewayExternalApiStatus()
      ]);
      setStatus(next);
      setExternalApiStatus(externalApi);
      setExternalApiToken("");
      setPortDraft(String(next.configuredPort));
      setFailureThresholdDraft(String(next.configuredFailureThreshold));
      setCircuitFailureThresholdDraft(String(next.configuredCircuitFailureThreshold));
      setCircuitDurationDraft(String(next.configuredCircuitDurationSeconds));
      setOpen(true);
    } catch (openError) {
      setNotice(captureError(openError, "getGatewayPort", "读取网关端口失败。"));
    }
  }

  async function saveGatewayPort() {
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      setError("端口必须是 0 到 65535 之间的整数。端口 0 表示自动分配。");
      return;
    }
    const failureThreshold = Number(failureThresholdDraft.trim());
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10) {
      setError("异常切换阈值必须是 1 到 10 之间的整数。");
      return;
    }
    const circuitFailureThreshold = Number(circuitFailureThresholdDraft.trim());
    if (!Number.isInteger(circuitFailureThreshold) || circuitFailureThreshold < 1 || circuitFailureThreshold > 20) {
      setError("熔断次数必须是 1 到 20 之间的整数。");
      return;
    }
    const circuitDurationSeconds = Number(circuitDurationDraft.trim());
    if (!Number.isInteger(circuitDurationSeconds) || circuitDurationSeconds < 10 || circuitDurationSeconds > 86400) {
      setError("熔断持续时间必须是 10 到 86400 秒之间的整数。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await window.codexConsole.setGatewayPort(
        port,
        failureThreshold,
        circuitFailureThreshold,
        circuitDurationSeconds
      );
      setStatus(result);
      setOpen(false);
      setNotice(result.applied
        ? `设置已保存：端口 ${result.configuredPort === 0 ? "自动分配" : result.configuredPort}，异常切换 ${result.configuredFailureThreshold} 次，熔断 ${result.configuredCircuitFailureThreshold} 次/${result.configuredCircuitDurationSeconds} 秒。`
        : `设置已保存：端口 ${result.configuredPort}（当前 Gateway 仍使用 ${result.activePort}，新建终端时生效），异常切换 ${result.configuredFailureThreshold} 次，熔断 ${result.configuredCircuitFailureThreshold} 次/${result.configuredCircuitDurationSeconds} 秒。`);
    } catch (saveError) {
      setError(captureError(saveError, "setGatewayPort", "保存网关端口失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function updateGatewayEnabled(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      setStatus(await window.codexConsole.setGatewayEnabled(enabled));
    } catch (toggleError) {
      setError(captureError(toggleError, "setGatewayEnabled", enabled ? "启用本地网关失败。" : "关闭本地网关失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function updateExternalApiEnabled(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      setExternalApiStatus(await window.codexConsole.setGatewayExternalApiEnabled(enabled));
    } catch (toggleError) {
      setError(captureError(toggleError, "setGatewayExternalApiEnabled", enabled ? "启用外部 API 失败。" : "关闭外部 API 失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function rotateExternalApiToken() {
    setBusy(true);
    setError("");
    try {
      const token = await window.codexConsole.rotateGatewayExternalApiToken();
      setExternalApiToken(token);
      setExternalApiStatus(await window.codexConsole.getGatewayExternalApiStatus());
    } catch (rotateError) {
      setError(captureError(rotateError, "rotateGatewayExternalApiToken", "生成外部访问令牌失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function copyExternalApiToken() {
    if (!externalApiToken) return;
    try {
      await window.codexConsole.copyText(externalApiToken);
      setNotice("外部访问令牌已复制。");
    } catch (copyError) {
      setError(captureError(copyError, "copyText", "复制外部访问令牌失败。"));
    }
  }

  function closeGatewayPortDialog() {
    setExternalApiToken("");
    setOpen(false);
  }

  return {
    open,
    setOpen,
    portDraft,
    setPortDraft,
    failureThresholdDraft,
    setFailureThresholdDraft,
    circuitFailureThresholdDraft,
    setCircuitFailureThresholdDraft,
    circuitDurationDraft,
    setCircuitDurationDraft,
    status,
    externalApiStatus,
    externalApiToken,
    error,
    busy,
    openGatewayPortDialog,
    saveGatewayPort,
    updateGatewayEnabled,
    updateExternalApiEnabled,
    rotateExternalApiToken,
    copyExternalApiToken,
    closeGatewayPortDialog,
  };
}
