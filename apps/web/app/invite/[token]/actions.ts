"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { acceptInvite, getValidInvite } from "@/lib/invites";
import { hashPassword, validatePassword } from "@/lib/password";

export type AcceptState = { error?: string };

/** 초대 수락 — 비번 설정으로 계정 생성 후 자동 로그인 → 설치(온보딩). */
export async function acceptInviteAction(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const invite = await getValidInvite(token);
  if (!invite) return { error: "유효하지 않거나 만료된 초대입니다." };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: "비밀번호가 일치하지 않습니다." };

  const hash = await hashPassword(password);
  const res = await acceptInvite(token, name, hash);
  if (!res) return { error: "초대 수락에 실패했습니다(만료됐거나 이미 가입된 이메일)." };

  try {
    await signIn("credentials", { email: res.email, password, redirectTo: "/onboarding" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: "가입은 됐지만 자동 로그인에 실패했습니다. 로그인 페이지에서 로그인하세요." };
    }
    throw e; // redirect 재전파
  }
}
