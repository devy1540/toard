"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { TeamRole } from "@/lib/team-tool-role";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignTeamRoleAction } from "./team-actions";

export function TeamRoleSelect({ userId, current, disabled }: { userId: string; current: TeamRole; disabled: boolean }) {
  const t = useTranslations("admin.teamRoleSelect");
  const [pending, startTransition] = useTransition();
  const onChange = (value: TeamRole) => startTransition(async () => {
    const result = await assignTeamRoleAction(userId, value);
    if (result.error) toast.error(result.error);
    else toast.success(t("updated"));
  });
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled || pending}>
      <SelectTrigger className="h-8 w-auto" aria-label={t("label")}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="member">{t("member")}</SelectItem><SelectItem value="leader">{t("leader")}</SelectItem></SelectContent>
    </Select>
  );
}
