"use client";

import { useState, useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignTeamAction } from "./team-actions";

const NONE = "none";

/** 멤버 행 인라인 팀 배정 — 변경 즉시 저장(revalidatePath 로 목록 갱신). */
export function TeamSelect({
  userId,
  current,
  teams,
}: {
  userId: string;
  current: string | null;
  teams: Array<{ id: string; name: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (value: string) => {
    setError(null);
    startTransition(async () => {
      const r = await assignTeamAction(userId, value === NONE ? null : value);
      if (r.error) setError(r.error);
    });
  };

  return (
    <div>
      <Select value={current ?? NONE} onValueChange={onChange} disabled={pending}>
        <SelectTrigger className="h-8 w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>팀 없음</SelectItem>
          {teams.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-destructive mt-1 text-xs">{error}</p> : null}
    </div>
  );
}
