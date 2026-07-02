"use server";

import { isValidEmail } from "@/lib/auth-policy";
import { createInvite } from "@/lib/invites";
import { getSessionUser } from "@/lib/session-user";

export type InviteState = { token?: string; email?: string; error?: string };

/** 초대 링크 생성 (관리자 전용). 성공 시 평문 토큰 반환(1회) → 페이지가 링크로 조립. */
export async function createInviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const me = await getSessionUser();
  if (me?.role !== "admin") return { error: "관리자만 초대할 수 있습니다." };

  const email = String(formData.get("email") ?? "")
    .toLowerCase()
    .trim();
  const role = String(formData.get("role") ?? "member");
  if (!isValidEmail(email)) return { error: "올바른 이메일 형식이 아닙니다." };

  const token = await createInvite(email, role, me.id);
  if (!token) return { error: "이미 가입된 이메일입니다." };
  return { token, email };
}
