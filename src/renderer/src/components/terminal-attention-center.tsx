import { AlertCircle, Bell, CheckCircle2, Clock3, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TerminalTab, TerminalTabAttention } from "../features/terminal/terminal-tab-state";

type TerminalAttentionCenterProps = {
  tabs: TerminalTab[];
  attentionByTabKey: Record<string, TerminalTabAttention>;
  onSelect: (tabKey: string) => void;
  onClear: (tabKey: string) => void;
  onDismiss: (tabKey: string) => void;
};

export function TerminalAttentionCenter({ tabs, attentionByTabKey, onSelect, onClear, onDismiss }: TerminalAttentionCenterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const entries = tabs
    .map((tab) => ({ tab, attention: attentionByTabKey[tab.key] }))
    .filter((entry): entry is { tab: TerminalTab; attention: TerminalTabAttention } => Boolean(entry.attention?.kind && entry.attention.unread))
    .sort((a, b) => b.attention.updatedAt - a.attention.updatedAt);
  const unreadCount = entries.filter((entry) => entry.attention.unread).length;
  useEffect(() => {
    if (entries.length === 0) setOpen(false);
  }, [entries.length]);
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);
  if (entries.length === 0) return null;

  return (
    <div ref={rootRef} className="terminal-attention-center">
      <button
        type="button"
        className={`terminal-attention-trigger ${open ? "active" : ""}`}
        aria-label="会话提醒"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="会话提醒"
        onClick={() => setOpen((current) => !current)}
      >
        <Bell aria-hidden="true" size={16} strokeWidth={1.9} />
        {unreadCount > 0 && <span className="terminal-attention-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <aside className="terminal-attention-popover" aria-label="会话状态提醒" role="dialog">
          <div className="terminal-attention-center-heading">
            <div>
              <strong>会话提醒</strong>
              <span>{unreadCount > 0 ? `${unreadCount} 项待处理` : `${entries.length} 项记录`}</span>
            </div>
            <button type="button" className="terminal-attention-close" aria-label="关闭会话提醒" title="关闭" onClick={() => setOpen(false)}>
              <X aria-hidden="true" size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="terminal-attention-list">
            {entries.map(({ tab, attention }) => {
              const Icon = attention.kind === "awaiting-confirmation" ? Clock3 : attention.kind === "error" ? AlertCircle : CheckCircle2;
              return (
                <div key={tab.key} className={`terminal-attention-item ${attention.kind} ${attention.unread ? "unread" : ""}`}>
                  <Icon aria-hidden="true" size={16} strokeWidth={2} />
                  <button type="button" className="terminal-attention-open" onClick={() => { onSelect(tab.key); onClear(tab.key); setOpen(false); }}>
                    <strong>{tab.title}</strong>
                    <span>{tab.target.provider} · {attention.title}{attention.detail ? `：${attention.detail}` : ""}</span>
                  </button>
                  <button type="button" className="terminal-attention-dismiss" title="移除提醒" aria-label={`移除 ${tab.title} 提醒`} onClick={() => onDismiss(tab.key)}>
                    <X aria-hidden="true" size={14} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}
