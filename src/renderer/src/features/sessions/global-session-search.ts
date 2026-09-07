import type { AiSession, AiTarget } from "../../types";
import { localFilterSessions, sessionTimestamp } from "./session-format";

export type GlobalSessionSearchSource = "summary" | "content";

export type GlobalSessionSearchResult = {
  target: AiTarget;
  session: AiSession;
  source: GlobalSessionSearchSource;
};

export type GlobalSessionSearchEntry = {
  target: AiTarget;
  sessions: AiSession[];
};

export function uniqueSearchTargets(cachedTargets: AiTarget[], currentTarget?: AiTarget) {
  const targets = currentTarget ? [...cachedTargets, currentTarget] : cachedTargets;
  return Array.from(new Map(targets.map((target) => [target.id, target])).values());
}

export function filterGlobalSearchEntries(
  entries: GlobalSessionSearchEntry[],
  providerId: string,
  targetId: string
) {
  return entries.filter(({ target }) =>
    (!providerId || target.provider === providerId) && (!targetId || target.id === targetId)
  );
}

export function createSummarySearchResults(
  entries: GlobalSessionSearchEntry[],
  query: string,
  providerId = "",
  targetId = ""
): GlobalSessionSearchResult[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  return filterGlobalSearchEntries(entries, providerId, targetId)
    .flatMap(({ target, sessions }) => localFilterSessions(sessions, normalizedQuery).map((session) => ({
      target,
      session,
      source: "summary" as const
    })))
    .sort(compareGlobalSearchResults);
}

export function mergeContentSearchResults(
  summaryResults: GlobalSessionSearchResult[],
  contentResults: GlobalSessionSearchResult[]
) {
  const merged = new Map<string, GlobalSessionSearchResult>();
  for (const result of contentResults) merged.set(globalResultKey(result), result);
  for (const result of summaryResults) merged.set(globalResultKey(result), result);
  return [...merged.values()].sort(compareGlobalSearchResults);
}

function compareGlobalSearchResults(left: GlobalSessionSearchResult, right: GlobalSessionSearchResult) {
  return sessionTimestamp(right.session) - sessionTimestamp(left.session)
    || left.target.label.localeCompare(right.target.label)
    || left.session.title.localeCompare(right.session.title);
}

function globalResultKey(result: GlobalSessionSearchResult) {
  return `${result.target.id}:${result.session.id}:${result.session.filePath}`;
}
