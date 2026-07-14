import { auth } from "@/auth";

export type ContentSessionInput = {
  authMode: string;
  sessionUserId: string | null | undefined;
};

/**
 * E2EE 본문 API는 dashboard viewer/dev fallback을 절대 사용하지 않는다.
 * open 모드에서도 실제 사용자 경계가 없으므로 본문 접근을 허용하지 않는다.
 */
export async function requireContentSessionWith({
  authMode,
  sessionUserId,
}: ContentSessionInput): Promise<string | null> {
  if (authMode === "open" || !sessionUserId) return null;
  return sessionUserId;
}

export function isContentAuthOpen(): boolean {
  return (process.env.AUTH_MODE ?? "oauth") === "open";
}

export async function requireContentSession(): Promise<string | null> {
  const session = await auth();
  return requireContentSessionWith({
    authMode: process.env.AUTH_MODE ?? "oauth",
    sessionUserId: session?.user?.id,
  });
}
