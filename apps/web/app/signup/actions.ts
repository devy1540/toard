"use server";

import { AuthError } from "next-auth";
import { credentialsEnabled, signIn } from "@/auth";
import { isEmailDomainAllowed, isValidEmail } from "@/lib/auth-policy";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword } from "@/lib/password";

export type SignupState = { error?: string };

/**
 * id/pw 가입. 도메인 게이팅 + 정책 검증 + 중복 차단 후 생성하고 자동 로그인.
 * 기존 이메일(특히 OAuth 계정)에는 비번을 덮어씌우지 않는다(계정 탈취 방지).
 */
export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  if (!credentialsEnabled) return { error: "비밀번호 가입이 비활성화되어 있습니다." };

  const email = String(formData.get("email") ?? "")
    .toLowerCase()
    .trim();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!isValidEmail(email)) return { error: "올바른 이메일 형식이 아닙니다." };
  if (!isEmailDomainAllowed(email)) return { error: "허용되지 않은 이메일 도메인입니다." };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: "비밀번호가 일치하지 않습니다." };

  const pool = getPool();
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if ((existing.rowCount ?? 0) > 0) return { error: "이미 가입된 이메일입니다." };

  const hash = await hashPassword(password);
  try {
    await pool.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'member')",
      [email, name || null, hash],
    );
  } catch (e) {
    // UNIQUE(email) 경합만 친절히 처리(위 SELECT 이후 동시 가입). 그 외 DB 오류는
    // 삼키지 않고 재전파해 실제 장애가 관측되게 한다.
    if ((e as { code?: string }).code === "23505") return { error: "이미 가입된 이메일입니다." };
    throw e;
  }

  try {
    // 가입 직후 설치(온보딩)로 안착
    await signIn("credentials", { email, password, redirectTo: "/onboarding" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: "가입은 완료됐지만 자동 로그인에 실패했습니다. 로그인 페이지에서 로그인하세요." };
    }
    throw e; // redirect 재전파
  }
}
