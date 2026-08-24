"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { credentialsEnabled, signIn } from "@/auth";
import { isEmailDomainAllowed, isValidEmail } from "@/lib/auth-policy";
import {
  clearCredentialAccountLimit,
  consumeCredentialAttempt,
  credentialClientIdentity,
  CredentialRateLimitError,
} from "@/lib/credential-rate-limit";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword } from "@/lib/password";
import { hasAdminUser } from "@/lib/setup";

export type SignupState = { error?: string };

/**
 * id/pw 가입. 도메인 게이팅 + 정책 검증 + 중복 차단 후 생성하고 자동 로그인.
 * 기존 이메일(특히 OAuth 계정)에는 비번을 덮어씌우지 않는다(계정 탈취 방지).
 */
export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const t = await getTranslations("auth");
  if (!credentialsEnabled) return { error: t("errors.signupDisabled") };
  if (!(await hasAdminUser())) return { error: t("errors.setupRequired") };

  const email = String(formData.get("email") ?? "")
    .toLowerCase()
    .trim();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!isValidEmail(email)) return { error: t("errors.invalidEmail") };
  if (!isEmailDomainAllowed(email)) return { error: t("errors.domainNotAllowed") };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: t("errors.passwordMismatch") };

  try {
    await consumeCredentialAttempt({
      channel: "signup",
      email,
      clientIdentity: credentialClientIdentity(await headers()),
    });
  } catch (error) {
    if (error instanceof CredentialRateLimitError) {
      return { error: t("errors.tooManyAttempts", { seconds: error.retryAfterSeconds }) };
    }
    throw error;
  }

  const pool = getPool();
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if ((existing.rowCount ?? 0) > 0) return { error: t("errors.emailAlreadyExists") };

  const hash = await hashPassword(password);
  try {
    await pool.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'member')",
      [email, name || null, hash],
    );
  } catch (e) {
    // UNIQUE(email) 경합만 친절히 처리(위 SELECT 이후 동시 가입). 그 외 DB 오류는
    // 삼키지 않고 재전파해 실제 장애가 관측되게 한다.
    if ((e as { code?: string }).code === "23505") return { error: t("errors.emailAlreadyExists") };
    throw e;
  }
  await clearCredentialAccountLimit({ channel: "signup", email });

  try {
    // 가입 직후 설치(설정의 설치 탭)로 안착
    await signIn("credentials", { email, password, redirectTo: "/settings?tab=install" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: t("errors.signupAutoLoginFailed") };
    }
    throw e; // redirect 재전파
  }
}
