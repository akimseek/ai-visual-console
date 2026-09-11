import { Check, ChevronDown, Lock, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiVendor, VendorRouteMode } from "../types";

type VendorRoutePickerProps = {
  vendorId?: string;
  vendorName: string;
  mode: VendorRouteMode;
  vendors: ApiVendor[];
  disabled: boolean;
  onSelectVendor: (vendorId: string) => Promise<void>;
  onSetMode: (mode: VendorRouteMode) => Promise<void>;
};

// 终端标签级路由入口。供应商凭据不会传入 DOM，只展示可用状态和名称。
export function VendorRoutePicker({
  vendorId,
  vendorName,
  mode,
  vendors,
  disabled,
  onSelectVendor,
  onSetMode
}: VendorRoutePickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vendor-route-picker" ref={rootRef}>
      <button
        type="button"
        className="vendor-route-picker-trigger"
        disabled={disabled || busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabled ? "当前终端未启用供应商网关" : "选择当前终端的供应商和路由模式"}
        onClick={() => setOpen((current) => !current)}
      >
        <strong>{vendorName || "-"}</strong>
        <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
      </button>
      {open && (
        <section className="vendor-route-picker-menu" role="dialog" aria-label="当前终端供应商路由">
          <header>
            <span>当前供应商</span>
            <div className="vendor-route-mode" aria-label="供应商路由模式">
              <button
                type="button"
                className={mode === "dynamic" ? "active" : ""}
                disabled={busy}
                onClick={() => void run(() => onSetMode("dynamic"))}
              >
                <Shuffle aria-hidden="true" size={13} strokeWidth={2} />
                动态
              </button>
              <button
                type="button"
                className={mode === "locked" ? "active" : ""}
                disabled={busy}
                onClick={() => void run(() => onSetMode("locked"))}
              >
                <Lock aria-hidden="true" size={13} strokeWidth={2} />
                锁定
              </button>
            </div>
          </header>
          <div className="vendor-route-picker-list" role="listbox" aria-label="可用供应商">
            {vendors.map((vendor) => {
              const selected = vendor.id === vendorId;
              const health = vendor.gatewayHealth?.status;
              return (
                <button
                  key={vendor.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "selected" : ""}
                  disabled={busy}
                  onClick={() => void run(async () => {
                    await onSelectVendor(vendor.id);
                    setOpen(false);
                  })}
                >
                  <span className="vendor-route-picker-name">{vendor.name}</span>
                  <span className={`vendor-route-picker-health ${health || "healthy"}`}>
                    {health === "open" ? "熔断中" : health === "degraded" ? "异常" : "可用"}
                  </span>
                  {selected && <Check className="vendor-route-picker-check" aria-hidden="true" size={15} strokeWidth={2.3} />}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
