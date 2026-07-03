"use server";

import { AuthError } from "next-auth";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/auth";
import { acceptInvite, getValidInvite } from "@/lib/invites";
import { hashPassword, validatePassword } from "@/lib/password";

export type AcceptState = { error?: string };

/** 초대 수락 — 비번 설정으로 계정 생성 후 자동 로그인 → 설치(온보딩). */
export async function acceptInviteAction(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const t = await getTranslations("invite");
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const invite = await getValidInvite(token);
  if (!invite) return { error: t("errors.invalidInvite") };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: t("errors.passwordMismatch") };

  const hash = await hashPassword(password);
  const res = await acceptInvite(token, name, hash);
  if (!res) return { error: t("errors.acceptFailed") };

  try {
    await signIn("credentials", { email: res.email, password, redirectTo: "/settings?tab=install" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: t("errors.autoLoginFailed") };
    }
    throw e; // redirect 재전파
  }
}
