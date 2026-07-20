import { History } from "lucide-react";
import { AutoRefresh } from "./auto-refresh";
import { Alert } from "@/components/ui/alert";

export function TeamAttributionFence({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Alert className="flex items-start gap-3 rounded-md p-4">
      <History className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <AutoRefresh />
    </Alert>
  );
}
