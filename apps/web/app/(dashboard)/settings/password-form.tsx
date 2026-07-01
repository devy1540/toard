"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, type PasswordState } from "./actions";

const INITIAL: PasswordState = {};

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [state, action, pending] = useActionState(changePasswordAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      {hasPassword ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="current">현재 비밀번호</Label>
          <Input id="current" name="current" type="password" autoComplete="current-password" required />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="next">새 비밀번호</Label>
        <Input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="8자 이상"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">새 비밀번호 확인</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-emerald-600 dark:text-emerald-400">저장되었습니다.</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "저장 중…" : hasPassword ? "변경" : "설정"}
      </Button>
    </form>
  );
}
