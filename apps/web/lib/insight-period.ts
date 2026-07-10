import type { PeriodQuery } from "@toard/core";
import { dayStartUtc } from "./org-time";

const DAY_MS = 86_400_000;
const INSIGHT_ANCHOR_MS = 10 * 60_000;
export const INSIGHT_PRESETS = ["7", "week", "month"] as const;
export type InsightPreset = (typeof INSIGHT_PRESETS)[number];

export interface InsightPeriodPair {
  preset: InsightPreset;
  current: PeriodQuery;
  previous: PeriodQuery;
  timezone: string;
}

export function parseInsightPreset(value: string | undefined): InsightPreset {
  return INSIGHT_PRESETS.includes(value as InsightPreset) ? (value as InsightPreset) : "7";
}

export function getInsightPeriodAnchor(now = new Date()): Date {
  return new Date(Math.floor(now.getTime() / INSIGHT_ANCHOR_MS) * INSIGHT_ANCHOR_MS);
}

function dateKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function monthStart(ymd: string, offset = 0): string {
  const [year, month] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
}

function weekStart(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return addDays(ymd, -weekday);
}

export function buildInsightPeriodPair(
  preset: InsightPreset,
  timezone: string,
  now = new Date(),
): InsightPeriodPair {
  if (preset === "7") {
    const current = { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
    return {
      preset,
      current,
      previous: { from: new Date(current.from.getTime() - 7 * DAY_MS), to: current.from },
      timezone,
    };
  }

  const today = dateKey(now, timezone);
  const currentStartKey = preset === "week" ? weekStart(today) : monthStart(today);
  const previousStartKey = preset === "week" ? addDays(currentStartKey, -7) : monthStart(currentStartKey, -1);
  const current = { from: dayStartUtc(currentStartKey, timezone), to: now };
  const previousFull = {
    from: dayStartUtc(previousStartKey, timezone),
    to: dayStartUtc(currentStartKey, timezone),
  };
  const elapsed = current.to.getTime() - current.from.getTime();
  const previousTo = new Date(Math.min(previousFull.to.getTime(), previousFull.from.getTime() + elapsed));
  return { preset, current, previous: { from: previousFull.from, to: previousTo }, timezone };
}
