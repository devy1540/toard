"use server";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { grantHistoryMfaAccess } from "@/lib/history-mfa";
import { beginPasskeyAuthentication, finishPasskeyAuthentication, getMfaStatus } from "@/lib/mfa-store";
import { getSessionUser } from "@/lib/session-user";
import { getWebAuthnContext } from "@/lib/webauthn-context";
import { safeHistoryReturnTo } from "./history-return";

export async function beginHistoryPasskeyAction() {
  const user = await getSessionUser();
  if (!user) throw new Error("LOGIN_REQUIRED");
  return beginPasskeyAuthentication({ userId: user.id, purpose: "history", context: await getWebAuthnContext() });
}

export async function completeHistoryPasskeyAction(input: {
  challengeId: string; response: AuthenticationResponseJSON; returnTo: string;
}): Promise<{ returnTo: string }> {
  const user = await getSessionUser();
  if (!user?.sessionId) throw new Error("LOGIN_REQUIRED");
  const status = await finishPasskeyAuthentication({
    userId: user.id, challengeId: input.challengeId, purpose: "history",
    response: input.response, context: await getWebAuthnContext(),
  });
  if (status.historyRequired) {
    await grantHistoryMfaAccess(user.id, status.version, user.sessionId);
  }
  return { returnTo: safeHistoryReturnTo(input.returnTo) };
}

export async function currentHistoryMfaStatus() {
  const user = await getSessionUser();
  return user ? getMfaStatus(user.id) : null;
}
