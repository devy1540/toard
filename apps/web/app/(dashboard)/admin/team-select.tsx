"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignTeamAction } from "./team-actions";

const NONE = "none";

/** 멤버 행 인라인 팀 배정 — 변경 즉시 저장(revalidatePath 로 목록 갱신), 결과는 토스트. */
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

  const onChange = (value: string) => {
    const name = value === NONE ? null : teams.find((t) => t.id === value)?.name;
    startTransition(async () => {
      const r = await assignTeamAction(userId, value === NONE ? null : value);
      if (r.error) toast.error(r.error);
      else toast.success(name ? `"${name}" 팀으로 배정했습니다.` : "팀 배정을 해제했습니다.");
    });
  };

  return (
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
  );
}
