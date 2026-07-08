"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CopyButton } from "@/components/dashboard/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInviteAction, type InviteState } from "./invite-actions";

const INITIAL: InviteState = {};
type Pending = { email: string; role: string; expiresAt: string };

export function InvitePanel({ baseUrl, pending }: { baseUrl: string; pending: Pending[] }) {
  const t = useTranslations("admin");
  const [state, action, isPending] = useActionState(createInviteAction, INITIAL);
  const link = state.token ? `${baseUrl}/invite/${state.token}` : null;
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
        <div className="flex items-center gap-2">
          <Label htmlFor="invite-role">{t("invites.roleLabel")}</Label>
          <select
            id="invite-role"
            name="role"
            className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </div>
        {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
        {/* flex-col 컨테이너가 버튼을 풀폭으로 늘리지 않게 — 폼 버튼은 콘텐츠 폭 */}
        <Button type="submit" disabled={isPending} className="self-start">
          {isPending ? t("invites.generating") : t("invites.generateSubmit")}
        </Button>
      </form>

      {link ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <p className="font-medium">{t("invites.linkHeading", { email: state.email ?? "" })}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">{link}</code>
            <CopyButton text={link} message={t("invites.linkCopied")} />
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{t("invites.linkExpiry")}</p>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">{t("invites.pendingHeading")}</p>
          <ul className="space-y-1 text-sm">
            {pending.map((p) => (
              <li key={p.email} className="flex items-center justify-between">
                <span>
                  {p.email} <span className="text-muted-foreground">({p.role})</span>
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
