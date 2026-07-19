"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TeamAttributionStatus } from "@/lib/team-attribution";
import {
  assignTeamAction,
  previewTeamAssignmentAction,
  requestLegacyTeamAttributionAction,
  type TeamAttributionPreviewDto,
} from "./team-actions";

const NONE = "none";

type Confirmation =
  | { kind: "assignment"; teamId: string; teamName: string; preview: TeamAttributionPreviewDto }
  | { kind: "legacy"; preview: TeamAttributionPreviewDto };

export function TeamSelect({
  userId,
  current,
  teams,
  status,
  legacyPreview,
}: {
  userId: string;
  current: string | null;
  teams: Array<{ id: string; name: string }>;
  status?: TeamAttributionStatus;
  legacyPreview?: TeamAttributionPreviewDto;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const assign = async (teamId: string | null, name: string | null) => {
    const result = await assignTeamAction(userId, teamId);
    if (result.error) {
      toast.error(result.error);
      return false;
    }
    toast.success(
      name ? t("teamSelect.assignedToast", { name }) : t("teamSelect.unassignedToast"),
    );
    router.refresh();
    return true;
  };

  const onChange = (value: string) => {
    const team = value === NONE ? null : teams.find((candidate) => candidate.id === value) ?? null;
    startTransition(async () => {
      if (!team || current !== null) {
        await assign(team?.id ?? null, team?.name ?? null);
        return;
      }
      const previewResult = await previewTeamAssignmentAction(userId, team.id);
      if (previewResult.error) {
        toast.error(previewResult.error);
        return;
      }
      if (previewResult.requiresConfirmation && previewResult.preview) {
        setConfirmation({
          kind: "assignment",
          teamId: team.id,
          teamName: previewResult.teamName ?? team.name,
          preview: previewResult.preview,
        });
        return;
      }
      await assign(team.id, team.name);
    });
  };

  const confirm = () => {
    if (!confirmation) return;
    startTransition(async () => {
      if (confirmation.kind === "assignment") {
        if (await assign(confirmation.teamId, confirmation.teamName)) setConfirmation(null);
        return;
      }
      const result = await requestLegacyTeamAttributionAction(userId);
      if (result.error) toast.error(result.error);
      else {
        toast.success(t("teamAttribution.legacyQueued"));
        setConfirmation(null);
        router.refresh();
      }
    });
  };

  const statusLabel = status?.state === "succeeded"
    ? t("teamAttribution.succeeded", { count: status.updatedEvents })
    : status?.state === "failed"
      ? t("teamAttribution.failed")
      : status
        ? t("teamAttribution.inProgress", { count: status.matchedEvents })
        : null;
  const preview = confirmation?.preview;
  const period = preview?.from && preview.to
    ? `${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(preview.from))} – ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(preview.to))}`
    : t("teamAttribution.periodUnknown");

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Select value={current ?? NONE} onValueChange={onChange} disabled={pending}>
        <SelectTrigger
          className="h-8 w-auto max-w-40 justify-start gap-1.5 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("teamSelect.none")}</SelectItem>
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {statusLabel ? (
        <span className="text-muted-foreground text-xs" data-attribution-state={status?.state}>
          {statusLabel}
        </span>
      ) : null}
      {legacyPreview && legacyPreview.events > 0 && !status ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 py-0 text-xs"
          disabled={pending}
          onClick={() => setConfirmation({ kind: "legacy", preview: legacyPreview })}
        >
          {t("teamAttribution.legacyButton")}
        </Button>
      ) : null}

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === "legacy"
                ? t("teamAttribution.legacyTitle")
                : t("teamAttribution.assignmentTitle", {
                    team: confirmation?.kind === "assignment" ? confirmation.teamName : "",
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === "legacy"
                ? t("teamAttribution.legacyDescription")
                : t("teamAttribution.assignmentDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground">{t("teamAttribution.events")}</dt>
              <dd className="text-right font-medium tabular-nums">{preview.events.toLocaleString(locale)}</dd>
              <dt className="text-muted-foreground">{t("teamAttribution.period")}</dt>
              <dd className="text-right">{period}</dd>
              <dt className="text-muted-foreground">{t("teamAttribution.tokens")}</dt>
              <dd className="text-right font-medium tabular-nums">{preview.totalTokens.toLocaleString(locale)}</dd>
              <dt className="text-muted-foreground">{t("teamAttribution.cost")}</dt>
              <dd className="text-right font-medium tabular-nums">${preview.costUsd.toFixed(2)}</dd>
            </dl>
          ) : null}
          <p className="text-muted-foreground text-xs">{t("teamAttribution.noOtherTeamsChanged")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{t("teamAttribution.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={confirm}>
              {t("teamAttribution.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
