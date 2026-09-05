import { useCallback, useEffect, useState } from "react";
import type { GatewayVendorHealth } from "../../types";
import { captureError } from "../../hooks/error-utils";

// 工作台挂载时读取一次网关健康快照；健康数据由 Gateway 持久化，避免渲染端自行轮询。
export function useWorkbenchHealth() {
  const [health, setHealth] = useState<GatewayVendorHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setHealth(await window.codexConsole.getGatewayVendorHealth());
      // 只在拿到完整健康快照后更新时间，失败时保留上一次可用数据的时间。
      setLastUpdatedAt(new Date());
    } catch (cause: unknown) {
      setError(captureError(cause, "workbenchHealth"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { health, loading, error, lastUpdatedAt, refresh };
}
