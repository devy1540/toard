"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { beginHistoryPasskeyAction, completeHistoryPasskeyAction } from "./mfa-actions";

export function HistoryMfaUnlock({ returnTo }: { returnTo: string }) {
  const t = useTranslations("dashboard.history.mfa");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function unlock(): Promise<void> {
    setPending(true);
    setError(undefined);
    try {
      const ceremony = await beginHistoryPasskeyAction();
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      const result = await completeHistoryPasskeyAction({ challengeId: ceremony.challengeId, response, returnTo });
      window.location.replace(result.returnTo);
    } catch {
      setError(t("invalidPasskey"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md py-8 sm:py-12">
      <Card>
        <CardHeader>
          <div className="bg-muted mb-1 flex size-10 items-center justify-center rounded-full">
            <LockKeyhole className="size-5" aria-hidden="true" />
          </div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("passkeyDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
          <Button type="button" className="w-full" onClick={unlock} disabled={pending} autoFocus>
            {pending ? t("unlocking") : t("unlockWithPasskey")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
