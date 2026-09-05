"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { configureLocalScope, type LocalShimStatus } from "@/lib/local-shim-client";

export function CollectionScopePanel({ targetId }: { targetId: string }) {
  const t = useTranslations("settings.install.scope");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LocalShimStatus | null>(null);
  const open = async () => {
    setBusy(true);
    try { setStatus(await configureLocalScope(targetId)); toast.success(t("saved")); }
    catch (error) {
      if (!(error instanceof Error && error.name === "LocalScopeCancelled")) {
        toast.error(t(error instanceof Error && error.name === "LocalScopeUnsupported" ? "unsupported" : "failed"));
      }
    } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t("title")}</CardTitle><CardDescription>{t("description")}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {status?.target.scope ? <p className="text-sm">{t(`mode.${status.target.scope.mode}`)}</p> : null}
        <Button variant="outline" disabled={busy} onClick={() => void open()}>{t(busy ? "opening" : "open")}</Button>
        <p className="text-muted-foreground text-xs">{t("localOnly")}</p>
      </CardContent>
    </Card>
  );
}
