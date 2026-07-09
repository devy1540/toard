"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { issueToken, revokeToken } from "@/lib/tokens";

export type TokenState = { token?: string; error?: string };

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
