"use server";

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { revalidatePath } from "next/cache";
import { clearHistoryMfaAccess, grantHistoryMfaAccess } from "@/lib/history-mfa";
import {
  beginPasskeyAuthentication, beginPasskeyRegistration, finishPasskeyAuthentication,
  finishPasskeyRegistration, updateMfaPolicies, deletePasskey,
} from "@/lib/mfa-store";
import { getSessionUser } from "@/lib/session-user";
import { getWebAuthnContext } from "@/lib/webauthn-context";

async function requireUser() {
  const user = await getSessionUser();
  if (!user) throw new Error("LOGIN_REQUIRED");
  return user;
}

export async function beginPasskeyRegistrationAction() {
  const user = await requireUser();
  return beginPasskeyRegistration({ userId: user.id, email: user.email, context: await getWebAuthnContext() });
}

export async function completePasskeyRegistrationAction(input: { challengeId: string; response: RegistrationResponseJSON }) {
  const user = await requireUser();
  const status = await finishPasskeyRegistration({
    userId: user.id, challengeId: input.challengeId, response: input.response,
    label: `Passkey`, context: await getWebAuthnContext(),
  });
  revalidatePath("/settings");
  return status;
}

export async function beginSettingsPasskeyAction() {
  const user = await requireUser();
  return beginPasskeyAuthentication({ userId: user.id, purpose: "settings", context: await getWebAuthnContext() });
}

export async function completePasskeyPolicyAction(input: {
  challengeId: string; response: AuthenticationResponseJSON; loginRequired: boolean; historyRequired: boolean;
}) {
  const user = await requireUser();
  await finishPasskeyAuthentication({
    userId: user.id, challengeId: input.challengeId, purpose: "settings",
    response: input.response, context: await getWebAuthnContext(),
  });
  const status = await updateMfaPolicies({
    userId: user.id, loginRequired: input.loginRequired, historyRequired: input.historyRequired,
  });
  if (status.historyRequired && user.sessionId) await grantHistoryMfaAccess(user.id, status.version, user.sessionId);
  else await clearHistoryMfaAccess();
  revalidatePath("/settings");
  return status;
}

export async function completeDeletePasskeyAction(input: {
  challengeId: string; response: AuthenticationResponseJSON; credentialId: string;
}) {
  const user = await requireUser();
  await finishPasskeyAuthentication({
    userId: user.id, challengeId: input.challengeId, purpose: "settings",
    response: input.response, context: await getWebAuthnContext(),
  });
  const status = await deletePasskey(user.id, input.credentialId);
  if (status.historyRequired && user.sessionId) await grantHistoryMfaAccess(user.id, status.version, user.sessionId);
  else await clearHistoryMfaAccess();
  revalidatePath("/settings");
  return status;
}
