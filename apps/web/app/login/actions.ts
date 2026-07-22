"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { AuthError } from "next-auth";
import { randomUUID } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/auth";
import { verifyCredentialUser } from "@/lib/credential-auth";
import { grantHistoryMfaAccess } from "@/lib/history-mfa";
import { createSignedMfaToken, verifySignedMfaToken } from "@/lib/mfa";
import { beginPasskeyAuthentication, finishPasskeyAuthentication, getMfaStatus, isCredentialMfaRequired } from "@/lib/mfa-store";
import { getWebAuthnContext } from "@/lib/webauthn-context";

const CREDENTIAL_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_TICKET_TTL_MS = 60 * 1000;

export type LoginState = {
  step?: "passkey";
  challenge?: string;
  options?: PublicKeyCredentialRequestOptionsJSON;
  error?: string;
};

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const t = await getTranslations("auth");
  const challengeToken = String(formData.get("challenge") ?? "");
  const passkeyResponse = String(formData.get("passkeyResponse") ?? "");
  if (challengeToken) {
    const payload = verifySignedMfaToken(challengeToken, "credential-challenge");
    if (!payload || !passkeyResponse) return { error: t("errors.mfaChallengeExpired") };
    let status;
    try {
      status = await finishPasskeyAuthentication({
        userId: payload.userId,
        challengeId: payload.nonce,
        purpose: "login",
        response: JSON.parse(passkeyResponse) as AuthenticationResponseJSON,
        context: await getWebAuthnContext(),
      });
    } catch {
      return { error: t("errors.invalidMfaCode") };
    }
    const sessionId = randomUUID();
    if (status.historyRequired) await grantHistoryMfaAccess(payload.userId, status.version, sessionId);
    const loginTicket = createSignedMfaToken({
      purpose: "credential-ticket", userId: payload.userId,
      expiresAt: Date.now() + CREDENTIAL_TICKET_TTL_MS, nonce: sessionId,
    });
    try {
      await signIn("credentials", { loginTicket, redirectTo: "/" });
      return {};
    } catch (error) {
      if (error instanceof AuthError) return { error: t("errors.invalidCredentials") };
      throw error;
    }
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t("errors.emailPasswordRequired") };
  const user = await verifyCredentialUser(email, password);
  if (!user) return { error: t("errors.invalidCredentials") };
  if (await isCredentialMfaRequired(user.id)) {
    try {
      const ceremony = await beginPasskeyAuthentication({ userId: user.id, purpose: "login", context: await getWebAuthnContext() });
      return {
        step: "passkey",
        options: ceremony.options,
        challenge: createSignedMfaToken({
          purpose: "credential-challenge", userId: user.id,
          expiresAt: Date.now() + CREDENTIAL_CHALLENGE_TTL_MS, nonce: ceremony.challengeId,
        }),
      };
    } catch {
      return { error: t("errors.mfaOperationFailed") };
    }
  }
  const sessionId = randomUUID();
  const loginTicket = createSignedMfaToken({
    purpose: "credential-ticket", userId: user.id,
    expiresAt: Date.now() + CREDENTIAL_TICKET_TTL_MS, nonce: sessionId,
  });
  try {
    await signIn("credentials", { loginTicket, redirectTo: "/" });
    return {};
  } catch (error) {
    if (error instanceof AuthError) return { error: t("errors.invalidCredentials") };
    throw error;
  }
}
