"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type TeamOption = { id: string; name: string };

/** 관리자용 팀 스코프 선택. 기존 기간·도구·지표 필터를 유지한 채 team 만 바꾼다. */
export function TeamFilter({
  teams,
  value,
  label,
}: {
  teams: TeamOption[];
  value: string;
  label: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const select = (teamId: string) => {
    if (teamId === value) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set("team", teamId);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <Select value={value} onValueChange={select}>
      <SelectTrigger className="h-8 w-fit min-w-32 max-w-48 justify-start gap-1.5 px-2.5" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[min(24rem,var(--radix-select-content-available-width))]">
        {teams.map((team) => (
          <SelectItem key={team.id} value={team.id} title={team.name}>
            {team.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
