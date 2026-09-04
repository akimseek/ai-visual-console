import { useState } from "react";
import type { GatewayPortStatus } from "../../types";
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function openGatewayPortDialog() {
    setError("");
    try {
      const next = await window.codexConsole.getGatewayPort();
      setStatus(next);
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
    error,
    busy,
    openGatewayPortDialog,
    saveGatewayPort
  };
}
