"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setupAdminAction, type SetupState } from "./actions";

const INITIAL: SetupState = {};

export function SetupForm() {
  const [state, action, pending] = useActionState(setupAdminAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">관리자 이메일</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">이름 (선택)</Label>
        <Input id="name" name="name" type="text" autoComplete="name" placeholder="Admin" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">비밀번호</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="8자 이상"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">비밀번호 확인</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "생성 중…" : "관리자 계정 만들기"}
      </Button>
    </form>
  );
}
