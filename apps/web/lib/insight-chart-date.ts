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

export function getInsightPositionDate(periodStart: Date, position: number, timezone: string): Date {
  const { year, month, day } = calendarParts(periodStart, timezone);
  return new Date(Date.UTC(year, month - 1, day + position, 12));
}
