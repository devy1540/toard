"use server";

import { auth } from "@/auth";
import { issueToken, revokeActiveTokens } from "@/lib/tokens";

export type TokenState = { token?: string; error?: string; revoked?: boolean };

/** 토큰 발급/재발급. 성공 시 평문 토큰을 1회 반환(이후 조회 불가). 실제 세션 필수. */
export async function issueTokenAction(_prev: TokenState, _formData: FormData): Promise<TokenState> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "로그인이 필요합니다." };
  try {
    const token = await issueToken(userId);
    return { token };
  } catch {
    return { error: "토큰 발급에 실패했습니다. 다시 시도하세요." };
  }
}

export async function revokeTokenAction(_prev: TokenState, _formData: FormData): Promise<TokenState> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: "로그인이 필요합니다." };
  await revokeActiveTokens(userId);
  return { revoked: true };
}
