"use client";

import { useActionState, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
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
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onDelete = (id: string) => {
    setDeleteError(null);
    startTransition(async () => {
      const r = await deleteTeamAction(id);
      if (r.error) setDeleteError(r.error);
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
                  onClick={() => onDelete(d.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">아직 팀이 없습니다. 아래에서 추가하세요.</p>
      )}

      {deleteError ? <p className="text-destructive text-xs">{deleteError}</p> : null}

      <form action={createAction} className="flex gap-2">
        <Input name="name" placeholder="새 팀 이름" maxLength={50} className="h-8" />
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? "추가 중…" : "추가"}
        </Button>
      </form>
      {createState.error ? <p className="text-destructive text-xs">{createState.error}</p> : null}
    </div>
  );
}
