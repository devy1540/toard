import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HistorySecurityLink({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Button asChild size="sm" variant="ghost" className={className}>
      <Link href="/settings?tab=account#history-security">
        <ShieldCheck className="size-4" />
        {label}
      </Link>
    </Button>
  );
}
