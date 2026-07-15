export type CalendarRange = {
  from?: Date;
  to?: Date;
};

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dateKeyToCalendarDate(value: string): Date | undefined {
  const match = DATE_KEY.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

export function calendarDateToDateKey(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateKeysToCalendarRange(from: string, to: string): CalendarRange | undefined {
  const fromDate = dateKeyToCalendarDate(from);
  const toDate = dateKeyToCalendarDate(to);
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) return undefined;
  return { from: fromDate, to: toDate };
}

export function isCompleteCalendarRange(range: CalendarRange | undefined): boolean {
  return range?.from != null && range.to != null;
}

export function calendarRangeToDateKeys(
  range: CalendarRange | undefined,
): { from: string; to: string } | undefined {
  if (!isCompleteCalendarRange(range)) return undefined;
  return {
    from: calendarDateToDateKey(range.from!),
    to: calendarDateToDateKey(range.to!),
  };
}
