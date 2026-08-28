import type { ApiVendor } from "./types";
import { listApiVendors } from "./vendorManager";

let snapshot: ApiVendor[] | null = null;
let loading: Promise<ApiVendor[]> | null = null;
let loadingVersion = -1;
let snapshotVersion = 0;

// Gateway 请求只读取内存快照，避免每次请求都打开 SQLite 并解析供应商配置。
export async function getGatewayVendorSnapshot(): Promise<ApiVendor[]> {
  if (snapshot) return snapshot;
  // 候选池在加载期间发生变更时，立即启动新版本读取；旧请求仍可完成，但不会覆盖新快照。
  if (!loading || loadingVersion !== snapshotVersion) {
    const version = snapshotVersion;
    const request = listApiVendors().then((vendors) => {
      if (version === snapshotVersion) snapshot = vendors;
      return vendors;
    });
    const current = request.finally(() => {
      if (loading === current) loading = null;
    });
    loading = current;
    loadingVersion = version;
  }
  return loading;
}

// 供应商增删改或候选池状态变化后调用；下一次请求会原子地建立新快照。
export function invalidateGatewayVendorSnapshot() {
  snapshotVersion += 1;
  snapshot = null;
}
