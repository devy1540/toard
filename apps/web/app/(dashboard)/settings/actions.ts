"use server";

import { getCurrentUserId } from "@/lib/current-user";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";

export type PasswordState = { error?: string; ok?: boolean };

/**
 * 비밀번호 변경/설정. 기존 비번이 있으면 현재 비번 확인 후 변경,
 * 없으면(OAuth 전용 계정) 새로 설정 → 이후 id/pw 로그인 가능.
 */
export async function changePasswordAction(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const userId = await getCurrentUserId();
  if (!userId) return { error: "로그인이 필요합니다." };

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const pwErr = validatePassword(next);
  if (pwErr) return { error: pwErr };
  if (next !== confirm) return { error: "새 비밀번호가 일치하지 않습니다." };

  const pool = getPool();
  const r = await pool.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId],
  );
  const currentHash = r.rows[0]?.password_hash ?? null;
  if (currentHash) {
    const ok = await verifyPassword(current, currentHash);
    if (!ok) return { error: "현재 비밀번호가 올바르지 않습니다." };
  }

  const hash = await hashPassword(next);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
  return { ok: true };
}
