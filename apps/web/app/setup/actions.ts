"use server";

import { AuthError } from "next-auth";
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
  const email = String(formData.get("email") ?? "")
    .toLowerCase()
    .trim();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!isValidEmail(email)) return { error: "올바른 이메일 형식이 아닙니다." };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: pwErr };
  if (password !== confirm) return { error: "비밀번호가 일치하지 않습니다." };

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
    if ((r.rowCount ?? 0) === 0) return { error: "이미 관리자가 설정되어 있습니다." };
  } catch {
    return { error: "관리자 생성에 실패했습니다. 다시 시도하세요." };
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
    return {};
  } catch (e) {
    if (e instanceof AuthError) {
      return { error: "관리자는 생성됐지만 자동 로그인에 실패했습니다. 로그인 페이지에서 로그인하세요." };
    }
    throw e; // redirect 재전파
  }
}
