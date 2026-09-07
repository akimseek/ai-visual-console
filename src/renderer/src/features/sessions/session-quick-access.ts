import type { SessionQuickAccess, SessionQuickAccessItem } from "../../types";

export const EMPTY_SESSION_QUICK_ACCESS: SessionQuickAccess = { favorites: [], recent: [] };

export function normalizeSessionQuickAccess(access: SessionQuickAccess): SessionQuickAccess {
  const favorites = uniqueItems(access.favorites).filter((item) => item.favorite);
  const favoriteKeys = new Set(favorites.map(sessionQuickAccessKey));
  return {
    favorites,
    recent: uniqueItems(access.recent).filter((item) => !favoriteKeys.has(sessionQuickAccessKey(item)))
  };
}

export function sessionQuickAccessKey(item: SessionQuickAccessItem) {
  return `${item.target.id}:${item.session.id}`;
}

function uniqueItems(items: SessionQuickAccessItem[]) {
  return [...new Map(items.map((item) => [sessionQuickAccessKey(item), item])).values()];
}
