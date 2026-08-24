"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { credentialsEnabled, oauthConfigured, signIn } from "@/auth";
import { isValidEmail } from "@/lib/auth-policy";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword } from "@/lib/password";
import { createFirstAdmin, verifyBootstrapSetupToken } from "@/lib/setup";

export type SetupState = { error?: string };

/**
 * 첫 실행 관리자 생성. DB 에 사용자가 0명일 때만 동작(원자적 가드).
 * 첫 사용자를 admin 으로 생성하고 자동 로그인. 이후엔 /setup 이 잠긴다.
 */
export async function setupAdminAction(_prev: SetupState, formData: FormData): Promise<SetupState> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "")
    .toLowerCase()
    .trim();
  const setupToken = String(formData.get("setupToken") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!verifyBootstrapSetupToken(setupToken)) return { error: t("errors.setupTokenInvalid") };
  if (!credentialsEnabled && !oauthConfigured) return { error: t("login.noLoginMethod") };
  if (!isValidEmail(email)) return { error: t("errors.invalidEmail") };
  if (credentialsEnabled) {
    const pwErr = validatePassword(password);
    if (pwErr) return { error: pwErr };
    if (password !== confirm) return { error: t("errors.passwordMismatch") };
  }

  const hash = credentialsEnabled ? await hashPassword(password) : null;
  try {
    const result = await createFirstAdmin(getPool(), {
      email,
      name: name || "Admin",
      passwordHash: hash,
    });
    if (!result.ok) {
      return {
        error: t(result.reason === "admin-exists" ? "errors.adminAlreadyExists" : "errors.emailAlreadyExists"),
      };
    }
  } catch {
    return { error: t("errors.adminCreateFailed") };
  }

  if (!credentialsEnabled) redirect("/login");

  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: t("errors.setupAutoLoginFailed") };
    }
    throw e; // redirect 재전파
  }
}
