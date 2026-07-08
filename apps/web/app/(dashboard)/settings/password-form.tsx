"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, type PasswordState } from "./actions";

const INITIAL: PasswordState = {};

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState(changePasswordAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      {hasPassword ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="current">{t("password.currentLabel")}</Label>
          <Input id="current" name="current" type="password" autoComplete="current-password" required />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="next">{t("password.nextLabel")}</Label>
        <Input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder={t("password.nextPlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">{t("password.confirmLabel")}</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t("password.saved")}</p>
      ) : null}
      {/* flex-col 컨테이너가 버튼을 풀폭으로 늘리지 않게 — 폼 버튼은 콘텐츠 폭 */}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t("password.saving") : hasPassword ? t("password.change") : t("password.set")}
      </Button>
    </form>
  );
}
