import type { SessionQuickAccessItem } from "../../types";
import { formatRelative } from "../../lib/format";

export function SessionQuickAccessPanel({
  favorites,
  recent,
  onOpen,
  emptyMessage
}: {
  favorites: SessionQuickAccessItem[];
  recent: SessionQuickAccessItem[];
  onOpen: (item: SessionQuickAccessItem) => void;
  emptyMessage?: string;
}) {
  if (favorites.length === 0 && recent.length === 0) {
    return emptyMessage ? <div className="empty-state session-quick-access-empty">{emptyMessage}</div> : null;
  }
  return (
    <section className="session-quick-access" aria-label="快捷会话">
      {favorites.length > 0 && <QuickAccessSection title="收藏" items={favorites} onOpen={onOpen} />}
      {recent.length > 0 && <QuickAccessSection title="最近打开" items={recent} onOpen={onOpen} />}
    </section>
  );
}

function QuickAccessSection({
  title,
  items,
  onOpen
}: {
  title: string;
  items: SessionQuickAccessItem[];
  onOpen: (item: SessionQuickAccessItem) => void;
}) {
  return (
    <div className="session-quick-access-section">
      <div className="session-quick-access-heading">{title}</div>
      {items.map((item) => (
        <button
          key={`${item.target.id}:${item.session.id}`}
          className="session-quick-access-row"
          type="button"
          title={`${item.target.label} · ${item.session.title}`}
          onClick={() => onOpen(item)}
        >
          <span className="session-quick-access-title">{item.session.title}</span>
          <span className="session-quick-access-meta">
            <span>{item.target.label}</span>
            <span>{formatRelative(item.lastOpenedAt || item.session.updatedAt || item.session.createdAt)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
