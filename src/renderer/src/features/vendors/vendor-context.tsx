import { createContext, useContext, type ReactNode } from "react";
import type { ApiVendor } from "../../types";

const VendorDataContext = createContext<ApiVendor[]>([]);

// 终端模型查询只读供应商快照，使用窄 Context 消除 App 到输入框的逐层透传。
export function VendorDataProvider({ vendors, children }: { vendors: ApiVendor[]; children: ReactNode }) {
  return <VendorDataContext.Provider value={vendors}>{children}</VendorDataContext.Provider>;
}

export function useVendorData() {
  return useContext(VendorDataContext);
}
