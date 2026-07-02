"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInviteAction, type InviteState } from "./invite-actions";

const INITIAL: InviteState = {};
type Pending = { email: string; role: string; expiresAt: string };

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* 무시 */
        }
      }}
    >
      {copied ? "복사됨" : "복사"}
    </Button>
  );
}

export function InvitePanel({ baseUrl, pending }: { baseUrl: string; pending: Pending[] }) {
  const [state, action, isPending] = useActionState(createInviteAction, INITIAL);
  const link = state.token ? `${baseUrl}/invite/${state.token}` : null;

  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">초대할 이메일</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="member@company.com"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="invite-role">역할</Label>
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
        <Button type="submit" disabled={isPending}>
          {isPending ? "생성 중…" : "초대 링크 생성"}
        </Button>
      </form>

      {link ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <p className="font-medium">{state.email} 초대 링크 — 전달하세요</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">{link}</code>
            <CopyButton text={link} />
          </div>
          <p className="text-muted-foreground mt-1 text-xs">7일 후 만료 · 1회용.</p>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">대기 중 초대</p>
          <ul className="space-y-1 text-sm">
            {pending.map((p) => (
              <li key={p.email} className="flex items-center justify-between">
                <span>
                  {p.email} <span className="text-muted-foreground">({p.role})</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  만료 {new Date(p.expiresAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
