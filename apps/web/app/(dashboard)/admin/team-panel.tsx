"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { createTeamAction, deleteTeamAction, type TeamState } from "./team-actions";

const INITIAL: TeamState = {};

export interface TeamRow {
  id: string;
  name: string;
  memberCount: number;
  hasEvents: boolean;
}

/** 팀 목록·생성·삭제. 삭제는 소속 멤버 0명 + 수집 이력 0건일 때만 활성(서버 액션이 재검증). */
export function TeamPanel({ teams }: { teams: TeamRow[] }) {
  const t = useTranslations("admin");
  const [createState, createAction, creating] = useActionState(createTeamAction, INITIAL);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const prevCreateState = useRef<TeamState>(INITIAL);

  useEffect(() => {
    if (createState === prevCreateState.current) return;
    prevCreateState.current = createState;
    if (createState.ok) {
      toast.success(t("teams.createdToast"));
      formRef.current?.reset();
    }
  }, [createState, t]);

  const onDelete = (team: TeamRow) => {
    startTransition(async () => {
      const r = await deleteTeamAction(team.id);
      if (r.error) toast.error(r.error);
      else toast.success(t("teams.deletedToast", { name: team.name }));
    });
  };

  return (
    <div className="space-y-4">
      {teams.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {teams.map((d) => {
            const deletable = d.memberCount === 0 && !d.hasEvents;
            return (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span>
                  {d.name}{" "}
                  <span className="text-muted-foreground">
                    {t("teams.memberCount", { count: d.memberCount })}
                  </span>
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground size-7"
                      disabled={!deletable || pending}
                      title={
                        deletable
                          ? t("teams.deleteTitle")
                          : d.memberCount > 0
                            ? t("teams.cannotDeleteHasMembers")
                            : t("teams.cannotDeleteHasEvents")
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("teams.deleteConfirmTitle", { name: d.name })}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("teams.deleteConfirmDescription")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("teams.cancel")}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => onDelete(d)}>
                        {t("teams.delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t("teams.empty")}</p>
      )}

      <form ref={formRef} action={createAction} className="flex gap-2">
        <Input name="name" placeholder={t("teams.createPlaceholder")} maxLength={50} className="h-8" />
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? t("teams.adding") : t("teams.addSubmit")}
        </Button>
      </form>
      {createState.error ? <p className="text-destructive text-xs">{createState.error}</p> : null}
    </div>
  );
}
