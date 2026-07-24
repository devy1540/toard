"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
        {state.error || passkeyError ? <FieldError>{state.error ?? passkeyError}</FieldError> : null}
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
      <FieldGroup className="gap-4">
        <FormField htmlFor="email" label={t("login.emailLabel")}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
        />
        </FormField>
        <FormField htmlFor="password" label={t("login.passwordLabel")}>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </FormField>
      </FieldGroup>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("login.submitting") : t("login.submit")}
      </Button>
    </form>
  );
}
