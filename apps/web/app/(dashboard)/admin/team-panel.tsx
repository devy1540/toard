"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
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
  const [createState, createAction, creating] = useActionState(createTeamAction, INITIAL);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const prevCreateState = useRef<TeamState>(INITIAL);

  useEffect(() => {
    if (createState === prevCreateState.current) return;
    prevCreateState.current = createState;
    if (createState.ok) {
      toast.success("팀을 추가했습니다.");
      formRef.current?.reset();
    }
  }, [createState]);

  const onDelete = (team: TeamRow) => {
    startTransition(async () => {
      const r = await deleteTeamAction(team.id);
      if (r.error) toast.error(r.error);
      else toast.success(`"${team.name}" 팀을 삭제했습니다.`);
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
                  {d.name} <span className="text-muted-foreground">· {d.memberCount}명</span>
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
                          ? "팀 삭제"
                          : d.memberCount > 0
                            ? "소속 멤버가 있어 삭제할 수 없습니다"
                            : "수집 이력이 귀속되어 삭제할 수 없습니다"
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>&quot;{d.name}&quot; 팀을 삭제할까요?</AlertDialogTitle>
                      <AlertDialogDescription>
                        소속 멤버와 수집 이력이 없는 팀만 삭제되며, 되돌릴 수 없습니다.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>취소</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => onDelete(d)}>
                        삭제
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">아직 팀이 없습니다. 아래에서 추가하세요.</p>
      )}

      <form ref={formRef} action={createAction} className="flex gap-2">
        <Input name="name" placeholder="새 팀 이름" maxLength={50} className="h-8" />
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? "추가 중…" : "추가"}
        </Button>
      </form>
      {createState.error ? <p className="text-destructive text-xs">{createState.error}</p> : null}
    </div>
  );
}
