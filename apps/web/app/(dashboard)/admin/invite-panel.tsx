"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CopyButton } from "@/components/dashboard/copy-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createInviteAction, type InviteState } from "./invite-actions";

const INITIAL: InviteState = {};
type Pending = { email: string; role: string; teamName: string | null; expiresAt: string };
type Team = { id: string; name: string };

export function InvitePanel({
  baseUrl,
  pending,
  teams,
}: {
  baseUrl: string;
  pending: Pending[];
  teams: Team[];
}) {
  const t = useTranslations("admin");
  const [state, action, isPending] = useActionState(createInviteAction, INITIAL);
  const [role, setRole] = useState("member");
  const [teamId, setTeamId] = useState("");
  const link = state.token ? `${baseUrl}/invite/${state.token}` : null;
  const hasTeams = teams.length > 0;
  // 생성 결과 토스트 — 같은 토큰으로 중복 발화 방지
  const toastedToken = useRef<string | null>(null);

  useEffect(() => {
    if (state.token && toastedToken.current !== state.token) {
      toastedToken.current = state.token;
      toast.success(t("invites.linkCreatedToast", { email: state.email ?? "" }));
    }
  }, [state.token, state.email, t]);

  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="role" value={role} />
        <input type="hidden" name="teamId" value={teamId} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">{t("invites.emailLabel")}</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="member@company.com"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="invite-role">{t("invites.roleLabel")}</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="invite-role" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">member</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="invite-team">{t("invites.teamLabel")}</Label>
          <Select value={teamId} onValueChange={setTeamId} disabled={!hasTeams}>
            <SelectTrigger id="invite-team" className="w-56 max-w-full">
              <SelectValue placeholder={t("invites.teamPlaceholder")} />
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
        {!hasTeams ? <p className="text-muted-foreground text-sm">{t("invites.noTeams")}</p> : null}
        {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
        {/* flex-col 컨테이너가 버튼을 풀폭으로 늘리지 않게 — 폼 버튼은 콘텐츠 폭 */}
        <Button type="submit" disabled={isPending || !hasTeams || !teamId} className="self-start">
          {isPending ? t("invites.generating") : t("invites.generateSubmit")}
        </Button>
      </form>

      {link ? (
        <Alert className="block rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <p className="font-medium">{t("invites.linkHeading", { email: state.email ?? "" })}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">{link}</code>
            <CopyButton text={link} message={t("invites.linkCopied")} />
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{t("invites.linkExpiry")}</p>
        </Alert>
      ) : null}

      {pending.length > 0 ? (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">{t("invites.pendingHeading")}</p>
          <ul className="space-y-1 text-sm">
            {pending.map((p) => (
              <li key={p.email} className="flex items-center justify-between">
                <span>
                  {p.email}{" "}
                  <span className="text-muted-foreground">
                    ({p.role}
                    {p.teamName ? ` · ${t("invites.pendingTeam", { team: p.teamName })}` : ""})
                  </span>
                </span>
                {/* 로캘 의존 포맷 — SSR 과 달라질 수 있어 클라이언트 값 유지 */}
                <span className="text-muted-foreground text-xs" suppressHydrationWarning>
                  {t("invites.pendingExpires", { date: new Date(p.expiresAt).toLocaleDateString() })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
