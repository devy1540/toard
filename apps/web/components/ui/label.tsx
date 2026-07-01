import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn Label 의 경량 버전 (@radix-ui/react-label 미도입 — 폼 라벨엔 native label 로 충분).
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
