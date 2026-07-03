"use server";

import { AuthError } from "next-auth";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/auth";
import { isValidEmail } from "@/lib/auth-policy";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword } from "@/lib/password";

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
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!isValidEmail(email)) return { error: t("errors.invalidEmail") };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: t("errors.passwordMismatch") };

  const hash = await hashPassword(password);
  try {
    // 사용자가 0명일 때만 INSERT — 동시 setup·재요청 방지(첫 실행 원자적 가드)
    const r = await getPool().query(
      `INSERT INTO users (email, name, password_hash, role)
       SELECT $1, $2, $3, 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id`,
      [email, name || "Admin", hash],
    );
    if ((r.rowCount ?? 0) === 0) return { error: t("errors.adminAlreadyExists") };
  } catch {
    return { error: t("errors.adminCreateFailed") };
  }

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
