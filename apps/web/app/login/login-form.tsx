"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">이메일</Label>
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
        <Label htmlFor="password">비밀번호</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "로그인 중…" : "로그인"}
      </Button>
    </form>
  );
}
