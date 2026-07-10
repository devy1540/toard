function calendarParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function calendarDateKey({ year, month, day }: ReturnType<typeof calendarParts>) {
  return year * 10_000 + month * 100 + day;
}

export function getInsightPositionDate(periodStart: Date, position: number, timezone: string): Date;
export function getInsightPositionDate(
  periodStart: Date,
  position: number,
  timezone: string,
  periodEndExclusive: Date,
): Date | null;
export function getInsightPositionDate(
  periodStart: Date,
  position: number,
  timezone: string,
  periodEndExclusive?: Date,
): Date | null {
  const { year, month, day } = calendarParts(periodStart, timezone);
  const positionDate = new Date(Date.UTC(year, month - 1, day + position, 12));

  if (periodEndExclusive) {
    const positionDateKey = calendarDateKey({
      year: positionDate.getUTCFullYear(),
      month: positionDate.getUTCMonth() + 1,
      day: positionDate.getUTCDate(),
    });
    const lastIncludedDateKey = calendarDateKey(
      calendarParts(new Date(periodEndExclusive.getTime() - 1), timezone),
    );
    if (positionDateKey > lastIncludedDateKey) return null;
  }

  return positionDate;
}
