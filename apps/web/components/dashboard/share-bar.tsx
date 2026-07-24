import { cn } from "@/lib/utils";

function ShareBar({ share, className }: { share: number; className?: string }) {
  const normalizedShare = Math.min(1, Math.max(0, share));
  const percent = normalizedShare > 0 ? Math.max(2, Math.round(normalizedShare * 100)) : 0;

  return (
    <div
      data-slot="share-bar"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalizedShare * 100)}
      className={cn("bg-muted h-1.5 overflow-hidden rounded-full", className)}
    >
      <div className="bg-chart-1 h-full rounded-full" style={{ width: `${percent}%` }} />
    </div>
  );
}

export { ShareBar };
