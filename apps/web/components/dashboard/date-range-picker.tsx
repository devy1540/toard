"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { enUS, ko } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function formatDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function formatRange(range: DateRange | undefined, locale: string, placeholder: string): string {
  if (!range?.from) return placeholder;
  const from = formatDate(range.from, locale);
  if (!range.to) return `${from} – …`;
  return `${from} – ${formatDate(range.to, locale)}`;
}

export function DateRangePicker({
  range,
  onSelect,
  locale,
  ariaLabel,
  placeholder,
}: {
  range: DateRange | undefined;
  onSelect: (range: DateRange | undefined) => void;
  locale: string;
  ariaLabel: string;
  placeholder: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-slot="date-range-picker"
          variant="outline"
          aria-label={ariaLabel}
          data-empty={!range?.from}
          className={cn(
            "h-8 w-full justify-start px-2.5 text-left font-normal sm:w-auto sm:min-w-64",
            "data-[empty=true]:text-muted-foreground",
          )}
        >
          <CalendarIcon />
          <span>{formatRange(range, locale, placeholder)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] overflow-x-auto p-0">
        <Calendar
          mode="range"
          min={0}
          numberOfMonths={1}
          defaultMonth={range?.from}
          selected={range}
          onSelect={onSelect}
          locale={locale.startsWith("ko") ? ko : enUS}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
