export const HISTORY_PAGE_SIZE = 20;

export interface HistoryListItem {
  key: string;
  href: string;
  providerKey: string;
  providerLabel: string;
  models: string[];
  preview: string;
  turnLabel: string;
  totalTokens: number | null;
  tokenUnit: string;
  hosts: string[];
  costLabel: string | null;
  noUsageLabel: string;
  latestTs: string;
}

export function historyDayKey(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function historyPagination(page: number, totalSessions: number): {
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
} {
  const totalPages = Math.max(1, Math.ceil(totalSessions / HISTORY_PAGE_SIZE));
  const normalizedPage = Math.min(totalPages, Math.max(1, Math.trunc(page) || 1));
  return {
    page: normalizedPage,
    totalPages,
    hasPrev: normalizedPage > 1,
    hasNext: normalizedPage < totalPages,
  };
}

export function compactHistoryList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max}`;
}
