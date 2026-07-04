"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setupAdminAction, type SetupState } from "./actions";

const INITIAL: SetupState = {};

export function SetupForm() {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(setupAdminAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("setup.emailLabel")}</Label>
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
        <Label htmlFor="name">{t("setup.nameLabel")}</Label>
        <Input id="name" name="name" type="text" autoComplete="name" placeholder="Admin" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("setup.passwordLabel")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder={t("setup.passwordPlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">{t("setup.confirmLabel")}</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("setup.submitting") : t("setup.submit")}
      </Button>
    </form>
  );
}
