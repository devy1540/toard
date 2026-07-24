"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
      <FieldGroup className="gap-4">
        <FormField label={t("emailLabel")}>
          <Input value={email} disabled readOnly />
        </FormField>
        {teamName ? (
          <FormField label={t("teamLabel")}>
            <Input value={teamName} disabled readOnly />
          </FormField>
        ) : null}
        <FormField htmlFor="name" label={t("nameLabel")}>
          <Input id="name" name="name" type="text" autoComplete="name" />
        </FormField>
        <FormField htmlFor="password" label={t("passwordLabel")}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder={t("passwordPlaceholder")}
          />
        </FormField>
        <FormField htmlFor="confirm" label={t("confirmLabel")}>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </FormField>
      </FieldGroup>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
