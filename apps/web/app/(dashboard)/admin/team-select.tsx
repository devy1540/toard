"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("admin");
  const [pending, startTransition] = useTransition();

  const onChange = (value: string) => {
    const name = value === NONE ? null : teams.find((team) => team.id === value)?.name;
    startTransition(async () => {
      const r = await assignTeamAction(userId, value === NONE ? null : value);
      if (r.error) toast.error(r.error);
      else
        toast.success(
          name ? t("teamSelect.assignedToast", { name }) : t("teamSelect.unassignedToast"),
        );
    });
  };

  return (
    <Select value={current ?? NONE} onValueChange={onChange} disabled={pending}>
      <SelectTrigger
        className="h-8 w-auto max-w-40 justify-start gap-1.5 [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("teamSelect.none")}</SelectItem>
        {teams.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
