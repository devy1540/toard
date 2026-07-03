import type { PeriodQuery } from "@toard/core";
import { startOfOrgToday } from "./org-time";

export function recentPeriod(days = 30): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

export interface DashboardSearchParams {
  period?: string;
  provider?: string;
}

/** URL searchParams → PeriodQuery. period: 'today'(조직 타임존 오늘 0시부터) | 일수(7·90, 기본 30). */
export function parseFilters(sp: DashboardSearchParams): PeriodQuery {
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  if (sp.period === "today") {
    return { from: startOfOrgToday(), to: new Date(), providerKey };
  }
  const days = sp.period === "7" ? 7 : sp.period === "90" ? 90 : 30;
  const { from, to } = recentPeriod(days);
  return { from, to, providerKey };
}
