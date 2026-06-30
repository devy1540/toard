import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-muted-foreground/50">{icon ?? <Inbox className="size-8" />}</div>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-muted-foreground max-w-xs text-xs">{description}</p> : null}
    </div>
  );
}
