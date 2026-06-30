import type { PeriodQuery } from "@toard/core";

export function recentPeriod(days = 30): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

export interface DashboardSearchParams {
  period?: string;
  provider?: string;
}

/** URL searchParams → PeriodQuery (기간·프로바이더 필터) */
export function parseFilters(sp: DashboardSearchParams): PeriodQuery {
  const days = sp.period === "7" ? 7 : sp.period === "90" ? 90 : 30;
  const { from, to } = recentPeriod(days);
  const providerKey = sp.provider && sp.provider !== "all" ? sp.provider : undefined;
  return { from, to, providerKey };
}
