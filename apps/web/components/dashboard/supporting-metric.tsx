import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

function SupportingMetric({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: ReactNode;
}) {
  return (
    <Card density="compact">
      <CardContent className="p-4">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <div className="mt-2 truncate text-2xl font-bold tracking-tight tabular-nums">{value}</div>
        <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>
      </CardContent>
    </Card>
  );
}

export { SupportingMetric };
