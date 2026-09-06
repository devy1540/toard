import { addLocalCalendarDays, canonicalTimezoneId, firstInstantOfLocalDate, localDateKey, USAGE_EVENT_LOGICAL_RETENTION_DAYS, type PeriodQuery } from "@toard/core";

export type ReportPeriod = {
  week: string;
  lastDate: string;
  previousWeek: string;
  timezone: string;
  current: PeriodQuery;
  previous: PeriodQuery;
  latestWeek: string;
};

/** Match the application's Sunday-start calendar weeks. Only completed weeks
 * with a full retained comparison interval may be reported as complete. */
export function reportPeriod(week: string | undefined, timezoneInput: string, now = new Date()): ReportPeriod {
  const timezone = canonicalTimezoneId(timezoneInput);
  if (!timezone || !Number.isFinite(now.getTime())) throw new Error("invalid_report_period");
  const today = localDateKey(now, timezone);
  const sunday = addLocalCalendarDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay());
  const latestWeek = addLocalCalendarDays(sunday, -7);
  const selected = week ?? latestWeek;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected)) throw new Error("invalid_report_period");
  // The core date helper rejects calendar overflow such as February 30.
  const from = firstInstantOfLocalDate(selected, timezone);
  if (new Date(`${selected}T12:00:00Z`).getUTCDay() !== 0 || selected > latestWeek) throw new Error("report_requires_completed_week");
  const previousWeek = addLocalCalendarDays(selected, -7);
  const previousFrom = firstInstantOfLocalDate(previousWeek, timezone);
  if (previousFrom.getTime() < now.getTime() - USAGE_EVENT_LOGICAL_RETENTION_DAYS * 86_400_000) throw new Error("report_outside_retention");
  return { week: selected, lastDate: addLocalCalendarDays(selected, 6), previousWeek, latestWeek, timezone,
    current: { from, to: firstInstantOfLocalDate(addLocalCalendarDays(selected, 7), timezone) },
    previous: { from: previousFrom, to: from } };
}
