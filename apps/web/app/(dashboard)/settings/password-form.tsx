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
  // 인라인 가로 폼 — 카드 우측 컬럼에서 필드 3개 + 버튼이 한 줄(좁으면 세로 폴백)
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        {hasPassword ? (
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="current">{t("password.currentLabel")}</Label>
            <Input id="current" name="current" type="password" autoComplete="current-password" required />
          </div>
        ) : null}
        <div className="flex flex-1 flex-col gap-1.5">
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
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="confirm">{t("password.confirmLabel")}</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </div>
        <Button type="submit" disabled={pending} className="self-start lg:self-end">
          {pending ? t("password.saving") : hasPassword ? t("password.change") : t("password.set")}
        </Button>
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t("password.saved")}</p>
      ) : null}
    </form>
  );
}
