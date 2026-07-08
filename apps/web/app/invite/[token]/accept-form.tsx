"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptInviteAction, type AcceptState } from "./actions";

const INITIAL: AcceptState = {};

export function AcceptForm({
  token,
  email,
  teamName,
}: {
  token: string;
  email: string;
  teamName: string | null;
}) {
  const t = useTranslations("invite");
  const [state, action, pending] = useActionState(acceptInviteAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <div className="flex flex-col gap-2">
        <Label>{t("emailLabel")}</Label>
        <Input value={email} disabled readOnly />
      </div>
      {teamName ? (
        <div className="flex flex-col gap-2">
          <Label>{t("teamLabel")}</Label>
          <Input value={teamName} disabled readOnly />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">{t("nameLabel")}</Label>
        <Input id="name" name="name" type="text" autoComplete="name" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("passwordLabel")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder={t("passwordPlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">{t("confirmLabel")}</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
