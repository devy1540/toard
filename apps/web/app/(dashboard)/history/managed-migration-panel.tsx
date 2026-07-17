"use client";

import { KeyRound, LoaderCircle, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function managedMigrationStateBody(action: "resume"): { action: "resume" };
export function managedMigrationStateBody(action: "block"): {
  action: "block";
  confirmation: "KEY_UNAVAILABLE";
};
export function managedMigrationStateBody(action: "resume" | "block") {
  return action === "resume"
    ? { action: "resume" as const }
    : { action: "block" as const, confirmation: "KEY_UNAVAILABLE" as const };
}

export function ManagedMigrationPanel({
  state,
  migrated,
  remaining,
  busy,
  error,
  onResume,
  onBlock,
}: {
  state: "pending" | "running" | "blocked";
  migrated: number;
  remaining: number;
  busy: boolean;
  error: string | null;
  onResume: () => void;
  onBlock: (confirmation: "KEY_UNAVAILABLE") => void;
}) {
  const t = useTranslations("dashboard.history.e2ee.migration");
  const blocked = state === "blocked";
  const total = migrated + remaining;
  const percent = total === 0 ? 100 : Math.round((migrated / total) * 100);

  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-muted p-2">
            {blocked
              ? <ShieldAlert className="size-5 text-amber-600" />
              : <LoaderCircle className="size-5 animate-spin text-primary" />}
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="font-medium">{blocked ? t("blockedTitle") : t("title")}</h2>
            <p className="text-sm text-muted-foreground">
              {blocked ? t("blockedDescription") : t("description")}
            </p>
          </div>
        </div>

        {!blocked ? (
          <div
            className="space-y-2"
            role="progressbar"
            aria-label={t("progressLabel", { migrated, remaining })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("progress", { migrated, remaining })}
            </p>
          </div>
        ) : null}

        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>{t("ciphertextPreserved")}</span>
        </p>
        {error ? <p role="alert" className="text-sm text-destructive">{t("error", { code: error })}</p> : null}

        <div className="flex flex-wrap gap-2">
          {blocked ? (
            <Button disabled={busy} onClick={onResume}>{t("resume")}</Button>
          ) : null}
          {!blocked ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={busy} variant="outline">{t("cannotRecover")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => onBlock(managedMigrationStateBody("block").confirmation)}
                  >
                    {t("confirmBlock")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
