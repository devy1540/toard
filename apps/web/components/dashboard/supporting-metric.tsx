import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

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
    <Card className="border-border/80 bg-card min-w-0 gap-0 rounded-xl border px-4 py-4 shadow-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 truncate text-2xl font-bold tracking-tight tabular-nums">{value}</div>
      <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>
    </Card>
  );
}

export { SupportingMetric };
