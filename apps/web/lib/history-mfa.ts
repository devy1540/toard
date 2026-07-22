import { cookies } from "next/headers";
import { auth } from "@/auth";
import { createSignedMfaToken, verifySignedMfaToken } from "./mfa";
import { getMfaStatus, type MfaStatus } from "./mfa-store";

export const HISTORY_MFA_COOKIE = "toard_history_mfa";
export const HISTORY_MFA_TTL_SECONDS = 30 * 60;

export type HistoryMfaGate = {
  required: boolean;
  verified: boolean;
  status: MfaStatus;
};

export function isHistoryMfaTokenValid(
  token: string | undefined,
  userId: string,
  status: MfaStatus,
  sessionId: string | undefined,
  nowMs = Date.now(),
  masterSecret?: string,
): boolean {
  if (!status.enrolled || !status.historyRequired) return true;
  if (!token || !sessionId) return false;
  const payload = masterSecret === undefined
    ? verifySignedMfaToken(token, "history-access", nowMs)
    : verifySignedMfaToken(token, "history-access", nowMs, masterSecret);
  return payload?.userId === userId && payload.mfaVersion === status.version && payload.nonce === sessionId;
}

export async function getHistoryMfaGate(userId: string): Promise<HistoryMfaGate> {
  const status = await getMfaStatus(userId);
  const required = status.enrolled && status.historyRequired;
  if (!required) return { required: false, verified: true, status };
  const [cookieStore, session] = await Promise.all([cookies(), auth()]);
  return {
    required: true,
    verified: isHistoryMfaTokenValid(
      cookieStore.get(HISTORY_MFA_COOKIE)?.value,
      userId,
      status,
      session?.mfaSessionId,
    ),
    status,
  };
}

export async function grantHistoryMfaAccess(userId: string, mfaVersion: number, sessionId: string): Promise<void> {
  const expiresAt = Date.now() + HISTORY_MFA_TTL_SECONDS * 1000;
  const token = createSignedMfaToken({
    purpose: "history-access",
    userId,
    mfaVersion,
    expiresAt,
    nonce: sessionId,
  });
  const cookieStore = await cookies();
  cookieStore.set(HISTORY_MFA_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: HISTORY_MFA_TTL_SECONDS,
  });
}

export async function clearHistoryMfaAccess(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(HISTORY_MFA_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}
