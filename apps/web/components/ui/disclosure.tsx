"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Disclosure({
  className,
  trigger,
  triggerClassName,
  contentClassName,
  children,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root> & {
  trigger: React.ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="disclosure"
      defaultOpen={defaultOpen}
      className={cn("text-sm", className)}
      {...props}
    >
      <CollapsiblePrimitive.Trigger
        data-slot="disclosure-trigger"
        className={cn(
          "group/disclosure-trigger focus-visible:border-ring focus-visible:ring-ring/50 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md outline-none transition-colors focus-visible:ring-[3px]",
          triggerClassName,
        )}
      >
        {trigger}
        <ChevronRight
          data-slot="disclosure-icon"
          className="size-3 shrink-0 transition-transform group-data-[state=open]/disclosure-trigger:rotate-90"
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content data-slot="disclosure-content" className={contentClassName}>
        {children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

export { Disclosure };
