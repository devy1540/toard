import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type FeatureStatus = "preview" | "beta";

const statusToneClassName: Record<FeatureStatus, string> = {
  preview:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/50 dark:text-orange-300",
  beta:
    "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/60 dark:bg-cyan-950/50 dark:text-cyan-300",
};

export function featureStatusBadgeClassName(status: FeatureStatus, className?: string): string {
  return cn(
    "rounded-full px-2 text-[11px] font-bold uppercase tracking-normal",
    statusToneClassName[status],
    className,
  );
}

export function FeatureStatusBadge({
  status,
  className,
  children,
}: {
  status: FeatureStatus;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Badge variant="outline" className={featureStatusBadgeClassName(status, cn("h-5", className))}>
      {children}
    </Badge>
  );
}
