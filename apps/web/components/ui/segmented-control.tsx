"use client";

import * as React from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type SegmentedControlItem<T extends string> = {
  value: T;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
};

type SegmentedControlProps<T extends string> = {
  value: T;
  items: readonly SegmentedControlItem<T>[];
  onValueChange: (value: T) => void;
  "aria-label": string;
  className?: string;
  itemClassName?: string;
};

function SegmentedControl<T extends string>({
  value,
  items,
  onValueChange,
  "aria-label": ariaLabel,
  className,
  itemClassName,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      spacing={1}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      data-slot="segmented-control"
      className={cn("border-input inline-flex max-w-full items-center gap-0.5 rounded-md border p-0.5", className)}
      aria-label={ariaLabel}
    >
      {items.map(({ value: itemValue, label, icon: Icon, disabled }) => {
        const selected = value === itemValue;
        return (
          <ToggleGroupItem
            key={itemValue}
            value={itemValue}
            data-slot="segmented-control-item"
            disabled={disabled}
            className={cn(
              "focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap shadow-none transition-[color,box-shadow] outline-none hover:bg-transparent hover:text-foreground focus-visible:ring-[3px] data-[state=on]:bg-muted data-[state=on]:text-foreground dark:data-[state=on]:bg-muted disabled:pointer-events-none disabled:opacity-50",
              selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              itemClassName,
            )}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{label}</span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

export { SegmentedControl, type SegmentedControlItem };
