"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getPool } from "@/lib/db";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";
import { activateTimezoneRollup, resolveSupportedRollupTimezone } from "@/lib/timezone-rollup";

export type PasswordState = { error?: string; ok?: boolean };

/**
 * 비밀번호 변경/설정. 기존 비번이 있으면 현재 비번 확인 후 변경,
 * 없으면(OAuth 전용 계정) 새로 설정 → 이후 id/pw 로그인 가능.
 * 반드시 실제 세션 필요 — open/dev 폴백의 가짜 신원(첫 user)으로는 비번을 바꿀 수 없다
 * (익명 방문자가 로그인 수단을 심는 것을 차단).
 */
export async function changePasswordAction(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const t = await getTranslations("settings");
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: t("errors.loginRequired") };

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const pwErr = validatePassword(next);
  if (pwErr) return { error: pwErr };
  if (next !== confirm) return { error: t("errors.passwordMismatch") };

  const pool = getPool();
  const r = await pool.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId],
  );
  const currentHash = r.rows[0]?.password_hash ?? null;
  if (currentHash) {
    const ok = await verifyPassword(current, currentHash);
    if (!ok) return { error: t("errors.currentPasswordWrong") };
  }

  const hash = await hashPassword(next);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
  return { ok: true };
}

export type TimezoneState = { error?: string; ok?: boolean };

/**
 * 표시 타임존 저장 — 빈 값('auto')이면 NULL(브라우저 자동 감지), 아니면 IANA 검증 후 저장.
 * 표출 전용 설정이라 위험도가 낮지만, 계정 설정과 동일하게 실제 세션을 요구한다.
 */
export async function saveTimezoneAction(
  _prev: TimezoneState,
  formData: FormData,
): Promise<TimezoneState> {
  const t = await getTranslations("settings");
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: t("errors.loginRequired") };

  const raw = String(formData.get("timezone") ?? "").trim();
  const automatic = raw === "" || raw === "auto";
  const tz = automatic ? null : await resolveSupportedRollupTimezone(raw);
  if (!automatic && !tz) return { error: t("errors.invalidTimezone") };

  await getPool().query("UPDATE users SET timezone = $1 WHERE id = $2", [tz, userId]);
  if (tz) void activateTimezoneRollup(tz).catch(() => undefined);
  revalidatePath("/", "layout"); // 모든 대시보드 화면의 기간 경계·라벨이 바뀐다
  return { ok: true };
}
