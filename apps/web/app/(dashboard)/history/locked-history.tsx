"use client";

import { useState } from "react";
import { KeyRound, Laptop, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LockedHistory({
  approval,
  secondsLeft,
  busy,
  onApprove,
  onLocalUnlock,
  canLocalUnlock,
  onRecover,
}: {
  approval: { code: string } | null;
  secondsLeft: number;
  busy: boolean;
  onApprove: () => void;
  onLocalUnlock: () => void;
  canLocalUnlock: boolean;
  onRecover: (mnemonic: string) => void;
}) {
  const t = useTranslations("dashboard.history.e2ee");
  const [showRecovery, setShowRecovery] = useState(false);
  const [mnemonic, setMnemonic] = useState("");

  return (
    <Card className="min-w-0 border-primary/20 bg-primary/[0.02]">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-4 shrink-0" />
          <CardTitle>{t("lockedTitle")}</CardTitle>
        </div>
        <CardDescription>{t("lockedDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {approval ? (
          <div className="min-w-0 rounded-lg border bg-background p-4" role="status" aria-live="polite">
            <p className="text-muted-foreground text-xs">{t("confirmationCode")}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em]" aria-label={t("confirmationCode")}>
              {approval.code}
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              {t("approvalCountdown", { minutes: Math.floor(secondsLeft / 60), seconds: secondsLeft % 60 })}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">{t("approvalCommand")}</p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap">
            {canLocalUnlock ? (
              <Button className="w-full sm:w-auto" disabled={busy} onClick={onLocalUnlock}>
                <Laptop />
                {t("unlockThisBrowser")}
              </Button>
            ) : <Button className="w-full sm:w-auto" disabled={busy} onClick={onApprove}>
              <Laptop />
              {t("approveComputer")}
            </Button>}
            <Button
              className="w-full sm:w-auto"
              variant="outline"
              disabled={busy}
              onClick={() => setShowRecovery((value) => !value)}
            >
              <ShieldAlert />
              {t("useRecoveryKit")}
            </Button>
          </div>
        )}

        {showRecovery && !approval ? (
          <form
            className="min-w-0 space-y-3 rounded-lg border bg-background p-4"
            onSubmit={(event) => {
              event.preventDefault();
              onRecover(mnemonic);
            }}
          >
            <label className="block min-w-0 text-sm font-medium">
              {t("recoveryWords")}
              <textarea
                className="border-input bg-background mt-2 min-h-28 w-full min-w-0 resize-y rounded-md border px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                autoComplete="off"
                spellCheck={false}
                value={mnemonic}
                onChange={(event) => setMnemonic(event.target.value)}
              />
            </label>
            <p className="text-muted-foreground text-xs">{t("recoveryLocalOnly")}</p>
            <Button type="submit" disabled={busy || mnemonic.trim().length === 0}>
              {t("recover")}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
