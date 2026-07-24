"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { FormField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { setupAdminAction, type SetupState } from "./actions";

const INITIAL: SetupState = {};

export function SetupForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(setupAdminAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <FormField htmlFor="email" label={t("setup.emailLabel")}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
          />
        </FormField>
        <FormField htmlFor="name" label={t("setup.nameLabel")}>
          <Input id="name" name="name" type="text" autoComplete="name" placeholder="Admin" />
        </FormField>
        <FormField htmlFor="password" label={t("setup.passwordLabel")}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder={t("setup.passwordPlaceholder")}
          />
        </FormField>
        <FormField htmlFor="confirm" label={t("setup.confirmLabel")}>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </FormField>
      </FieldGroup>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("setup.submitting") : t("setup.submit")}
      </Button>
    </form>
  );
}
