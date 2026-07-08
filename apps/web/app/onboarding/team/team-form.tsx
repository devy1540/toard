"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TeamOption } from "@/lib/team-onboarding";
import { chooseTeamAction, type TeamOnboardingState } from "./actions";

const INITIAL: TeamOnboardingState = {};

export function TeamOnboardingForm({ teams }: { teams: TeamOption[] }) {
  const t = useTranslations("auth");
  const [value, setValue] = useState("");
  const [state, action, pending] = useActionState(chooseTeamAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="teamId" value={value} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="team-select">{t("teamOnboarding.teamLabel")}</Label>
        <Select value={value} onValueChange={setValue} disabled={pending}>
          <SelectTrigger id="team-select" className="w-full">
            <SelectValue placeholder={t("teamOnboarding.teamPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending || !value}>
        {pending ? t("teamOnboarding.submitting") : t("teamOnboarding.submit")}
      </Button>
    </form>
  );
}
