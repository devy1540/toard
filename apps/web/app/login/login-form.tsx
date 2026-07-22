"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = {};

export function LoginForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(loginAction, INITIAL);
  const [launching, setLaunching] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string>();
  const [, startTransition] = useTransition();

  async function verifyPasskey(): Promise<void> {
    if (!state.options || !state.challenge) return;
    setLaunching(true);
    setPasskeyError(undefined);
    try {
      const response = await startAuthentication({ optionsJSON: state.options });
      const data = new FormData();
      data.set("challenge", state.challenge);
      data.set("passkeyResponse", JSON.stringify(response));
      startTransition(() => action(data));
    } catch {
      setPasskeyError(t("errors.invalidMfaCode"));
    } finally {
      setLaunching(false);
    }
  }

  if (state.step === "passkey" && state.challenge && state.options) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("login.passkeyDescription")}</p>
        {state.error || passkeyError ? <p role="alert" className="text-destructive text-sm">{state.error ?? passkeyError}</p> : null}
        <Button type="button" onClick={verifyPasskey} disabled={pending || launching} autoFocus>
          {pending || launching ? t("login.verifyingMfa") : t("login.verifyPasskey")}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/login">{t("login.useAnotherAccount")}</Link>
        </Button>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("login.emailLabel")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("login.passwordLabel")}</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error ? <p role="alert" className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("login.submitting") : t("login.submit")}
      </Button>
    </form>
  );
}
