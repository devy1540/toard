import type { SessionUsageSummary } from "@toard/core";
import { getE2eeHistorySessions } from "./e2ee-history";
import { parseFilters } from "./period";

export const E2EE_HISTORY_PAGE_SIZE = 20;

export async function loadE2eeHistoryPage(args: {
  userId: string;
  searchParams: URLSearchParams;
  timezone: string;
  loadSessions?: typeof getE2eeHistorySessions;
  loadUsage: (userId: string, sessionIds: string[]) => Promise<SessionUsageSummary[]>;
}) {
  const pageNumber = Math.min(5_001, Math.max(1, parseInteger(args.searchParams.get("page")) ?? 1));
  const filter = parseFilters({
    period: args.searchParams.get("period") ?? undefined,
    provider: args.searchParams.get("provider") ?? undefined,
    from: args.searchParams.get("from") ?? undefined,
    to: args.searchParams.get("to") ?? undefined,
  }, args.timezone, "all");
  const loadSessions = args.loadSessions ?? getE2eeHistorySessions;
  const page = await loadSessions(args.userId, {
    limit: E2EE_HISTORY_PAGE_SIZE,
    offset: (pageNumber - 1) * E2EE_HISTORY_PAGE_SIZE,
    filter: { from: filter.from, to: filter.to, providerKey: filter.providerKey },
  });
  const sessionIds = page.sessions.filter((session) => session.isSession).map((session) => session.key);
  const summaries = sessionIds.length > 0 ? await args.loadUsage(args.userId, sessionIds) : [];
  const usageBySession = new Map(summaries.map((summary) => [summary.sessionId, summary]));

  return {
    ...page,
    sessions: page.sessions.map((session) => ({
      ...session,
      usage: session.isSession ? usageBySession.get(session.key) ?? null : null,
    })),
  };
}

function parseInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
