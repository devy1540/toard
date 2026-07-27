"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { surfaceVariants, type SurfaceVariant } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

const disclosureTriggerVariants = cva(
  "group/disclosure-trigger focus-visible:border-ring focus-visible:ring-ring/50 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md outline-none transition-colors focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        plain: "",
        pill: "text-muted-foreground hover:text-foreground bg-muted/40 rounded-full border px-3 py-1 text-xs",
        panel: "bg-muted/20 hover:bg-muted/40 w-full min-w-0 justify-between rounded-xl border px-3 py-2 text-left",
      },
    },
    defaultVariants: {
      variant: "plain",
    },
  },
);

function Disclosure({
  className,
  trigger,
  triggerClassName,
  contentClassName,
  preview,
  triggerPlacement = "before",
  forceMount = false,
  surface = "none",
  triggerVariant,
  children,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root> & {
    trigger: React.ReactNode;
    triggerClassName?: string;
    contentClassName?: string;
    preview?: React.ReactNode;
    triggerPlacement?: "before" | "after";
    forceMount?: boolean;
    surface?: "none" | SurfaceVariant;
    triggerVariant?: VariantProps<typeof disclosureTriggerVariants>["variant"];
  }) {
  const triggerElement = (
    <CollapsiblePrimitive.Trigger
      data-slot="disclosure-trigger"
      className={cn(disclosureTriggerVariants({ variant: triggerVariant }), triggerClassName)}
    >
      {trigger}
      <ChevronRight
        data-slot="disclosure-icon"
        className="size-3 shrink-0 transition-transform group-data-[state=open]/disclosure-trigger:rotate-90"
      />
    </CollapsiblePrimitive.Trigger>
  );

  return (
    <CollapsiblePrimitive.Root
      data-slot="disclosure"
      data-surface={surface}
      defaultOpen={defaultOpen}
      className={cn(
        "group/disclosure text-sm",
        surface === "none" ? null : surfaceVariants({ variant: surface }),
        className,
      )}
      {...props}
    >
      {preview ? (
        <div data-slot="disclosure-preview" className="group-data-[state=open]/disclosure:hidden">
          {preview}
        </div>
      ) : null}
      {triggerPlacement === "before" ? triggerElement : null}
      <CollapsiblePrimitive.Content
        data-slot="disclosure-content"
        forceMount={forceMount || undefined}
        className={cn(forceMount && "data-[state=closed]:hidden", contentClassName)}
      >
        {children}
      </CollapsiblePrimitive.Content>
      {triggerPlacement === "after" ? triggerElement : null}
    </CollapsiblePrimitive.Root>
  );
}

export { Disclosure };
