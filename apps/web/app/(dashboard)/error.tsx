"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("dashboard");

  return (
    <div className="py-10">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyTitle>{t("temporaryUnavailableTitle")}</EmptyTitle>
          <EmptyDescription>{t("temporaryUnavailableDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="sm" onClick={reset}>
            <RefreshCw className="size-4" />
            {t("retry")}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
