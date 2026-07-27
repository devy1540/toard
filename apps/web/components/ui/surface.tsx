import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const surfaceVariants = cva("min-w-0 border", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground shadow-sm",
      inset: "bg-background text-foreground shadow-none",
      muted: "bg-muted/20 text-foreground shadow-none",
      accent: "border-transparent bg-primary/10 text-foreground shadow-none",
    },
    radius: {
      sm: "rounded-md",
      md: "rounded-lg",
      lg: "rounded-xl",
      xl: "rounded-2xl",
      full: "rounded-full",
    },
    padding: {
      none: "",
      sm: "p-2",
      md: "p-3",
      lg: "p-4",
    },
  },
  defaultVariants: {
    variant: "inset",
    radius: "md",
    padding: "none",
  },
});

type SurfaceVariant = NonNullable<VariantProps<typeof surfaceVariants>["variant"]>;

function Surface({
  className,
  variant,
  radius,
  padding,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof surfaceVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="surface"
      data-variant={variant ?? "inset"}
      data-radius={radius ?? "md"}
      data-padding={padding ?? "none"}
      className={cn(surfaceVariants({ variant, radius, padding, className }))}
      {...props}
    />
  );
}

export { Surface, surfaceVariants, type SurfaceVariant };
