"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { MfaStatus } from "@/lib/mfa-store";
import {
  beginPasskeyRegistrationAction, beginSettingsPasskeyAction,
  completeDeletePasskeyAction, completePasskeyPolicyAction, completePasskeyRegistrationAction,
} from "./mfa-actions";

export function MfaSettingsPanel({ initial, hasPassword }: { initial: { status: MfaStatus }; hasPassword: boolean }) {
  const t = useTranslations("settings.mfa");
  const [status, setStatus] = useState(initial.status);
  const [loginRequired, setLoginRequired] = useState(initial.status.loginRequired);
  const [historyRequired, setHistoryRequired] = useState(initial.status.historyRequired);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function register(): Promise<void> {
    setPending(true); setError(undefined); setNotice(undefined);
    try {
      const ceremony = await beginPasskeyRegistrationAction();
      const response = await startRegistration({ optionsJSON: ceremony.options });
      const next = await completePasskeyRegistrationAction({ challengeId: ceremony.challengeId, response });
      setStatus(next); setNotice(t("passkeyAdded"));
    } catch { setError(t("errors.passkeyFailed")); }
    finally { setPending(false); }
  }

  async function save(): Promise<void> {
    setPending(true); setError(undefined); setNotice(undefined);
    try {
      const ceremony = await beginSettingsPasskeyAction();
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      const next = await completePasskeyPolicyAction({ challengeId: ceremony.challengeId, response, loginRequired, historyRequired });
      setStatus(next); setNotice(t("saved"));
    } catch { setError(t("errors.passkeyFailed")); }
    finally { setPending(false); }
  }

  async function remove(credentialId: string): Promise<void> {
    setPending(true); setError(undefined); setNotice(undefined);
    try {
      const ceremony = await beginSettingsPasskeyAction();
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      const next = await completeDeletePasskeyAction({ challengeId: ceremony.challengeId, response, credentialId });
      setStatus(next); setLoginRequired(next.loginRequired); setHistoryRequired(next.historyRequired); setNotice(t("passkeyRemoved"));
    } catch { setError(t("errors.passkeyRemoveFailed")); }
    finally { setPending(false); }
  }

  return (
    <Card id="mfa-security" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle>{t("passkeyTitle")}</CardTitle>
          <Badge variant={status.enrolled ? "secondary" : "outline"}>{status.enrolled ? t("statusEnabled") : t("statusDisabled")}</Badge>
        </div>
        <CardDescription>{t("passkeyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        {error ? <p role="alert" className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm">{error}</p> : null}
        {notice ? <p role="status" className="bg-muted rounded-lg p-3 text-sm">{notice}</p> : null}
        <Button type="button" onClick={register} disabled={pending}>{pending ? t("passkeyOpening") : t("addPasskey")}</Button>
        {status.passkeys.length ? (
          <ul className="divide-y rounded-lg border" aria-label={t("registeredPasskeys")}>
            {status.passkeys.map((key, index) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span>{key.label} {status.passkeys.length > 1 ? index + 1 : ""}</span>
                <span className="flex items-center gap-2"><span className="text-muted-foreground">{key.backedUp ? t("syncedPasskey") : t("devicePasskey")}</span><Button type="button" size="sm" variant="ghost" onClick={() => remove(key.id)} disabled={pending}>{t("removePasskey")}</Button></span>
              </li>
            ))}
          </ul>
        ) : null}
        {status.enrolled ? (
          <div className="space-y-4 border-t pt-4">
            <div className="divide-y rounded-lg border">
              <label className="flex items-start justify-between gap-4 p-4">
                <span><span className="block text-sm font-medium">{t("loginProtection")}</span><span className="text-muted-foreground mt-1 block text-xs">{hasPassword ? t("passkeyLoginDescription") : t("loginProtectionNeedsPassword")}</span></span>
                <Switch checked={loginRequired} onCheckedChange={setLoginRequired} disabled={!hasPassword} aria-label={t("loginProtection")} />
              </label>
              <label className="flex items-start justify-between gap-4 p-4">
                <span><span className="block text-sm font-medium">{t("historyProtection")}</span><span className="text-muted-foreground mt-1 block text-xs">{t("passkeyHistoryDescription")}</span></span>
                <Switch checked={historyRequired} onCheckedChange={setHistoryRequired} aria-label={t("historyProtection")} />
              </label>
            </div>
            <Button type="button" onClick={save} disabled={pending}>{pending ? t("saving") : t("saveWithPasskey")}</Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
