"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import {
  getTokenConnectionStatus,
  issueDeviceToken,
  issueToken,
  revokeToken,
  type TokenConnectionStatus,
} from "@/lib/tokens";

export type TokenState = { token?: string; tokenId?: string; error?: string };

/** 새 연결 마법사용 토큰 발급. 성공 시 평문 토큰과 소유권 확인용 ID를 1회 반환한다. */
export async function issueOnboardingTokenAction(): Promise<TokenState> {
  const t = await getTranslations("settings");
  const userId = (await auth())?.user?.id;
  if (!userId) return { error: t("errors.loginRequired") };
  try {
    const issued = await issueDeviceToken(userId);
    revalidatePath("/settings");
    return issued;
  } catch {
    return { error: t("errors.issueTokenFailed") };
  }
}

/** 발급한 토큰의 첫 인증 요청을 현재 로그인 사용자 소유권 안에서만 확인한다. */
export async function checkTokenConnectionAction(
  tokenId: string,
): Promise<TokenConnectionStatus> {
  const userId = (await auth())?.user?.id;
  if (!userId || !tokenId) return { connected: false, lastUsedAt: null, lastHost: null };
  return getTokenConnectionStatus(userId, tokenId);
}

/** 토큰 발급/재발급. 성공 시 평문 토큰을 1회 반환(이후 조회 불가). 실제 세션 필수. */
export async function issueTokenAction(_prev: TokenState, _formData: FormData): Promise<TokenState> {
  const t = await getTranslations("settings");
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { error: t("errors.loginRequired") };
  try {
    const label = _formData.get("label");
    const token = await issueToken(userId, typeof label === "string" ? label : null);
    revalidatePath("/settings");
    return { token };
  } catch {
    return { error: t("errors.issueTokenFailed") };
  }
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return;
  const tokenId = formData.get("tokenId");
  if (typeof tokenId !== "string" || !tokenId) return;
  await revokeToken(userId, tokenId);
  revalidatePath("/settings");
}
