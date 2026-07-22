import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { getPool } from "./db";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type PasskeyPurpose = "registration" | "login" | "history" | "settings";
export type WebAuthnContext = { origin: string; rpID: string; rpName: string };
export type MfaStatus = {
  enrolled: boolean;
  loginRequired: boolean;
  historyRequired: boolean;
  version: number;
  passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }[];
};

export class MfaError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "MfaError";
  }
}

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const [settings, passkeys] = await Promise.all([
    getPool().query<{ login_required: boolean; history_required: boolean; version: number }>(
      "SELECT login_required, history_required, version FROM user_mfa_settings WHERE user_id = $1",
      [userId],
    ),
    getPool().query<{ credential_id: string; label: string; created_at: Date; last_used_at: Date | null; backed_up: boolean }>(
      `SELECT credential_id, label, created_at, last_used_at, backed_up
         FROM user_passkeys WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    ),
  ]);
  const row = settings.rows[0];
  return {
    enrolled: passkeys.rows.length > 0,
    loginRequired: passkeys.rows.length > 0 && row?.login_required === true,
    historyRequired: passkeys.rows.length > 0 && row?.history_required === true,
    version: row?.version ?? 0,
    passkeys: passkeys.rows.map((key) => ({
      id: key.credential_id,
      label: key.label,
      createdAt: key.created_at.toISOString(),
      lastUsedAt: key.last_used_at?.toISOString() ?? null,
      backedUp: key.backed_up,
    })),
  };
}

export async function beginPasskeyRegistration(input: {
  userId: string; email: string; context: WebAuthnContext;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const existing = await loadCredentials(input.userId);
  const options = await generateRegistrationOptions({
    rpName: input.context.rpName,
    rpID: input.context.rpID,
    userName: input.email,
    userDisplayName: input.email,
    userID: new TextEncoder().encode(input.userId),
    attestationType: "none",
    excludeCredentials: existing.map((key) => ({ id: key.id, transports: key.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    preferredAuthenticatorType: "localDevice",
  });
  return { challengeId: await saveChallenge(input.userId, "registration", options.challenge), options };
}

export async function finishPasskeyRegistration(input: {
  userId: string; challengeId: string; response: RegistrationResponseJSON; label: string; context: WebAuthnContext;
}): Promise<MfaStatus> {
  const challenge = await takeChallenge(input.userId, input.challengeId, "registration");
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: input.context.origin,
    expectedRPID: input.context.rpID,
    requireUserVerification: true,
  }).catch(() => null);
  if (!verification?.verified || !verification.registrationInfo) throw new MfaError("PASSKEY_VERIFICATION_FAILED");
  const info = verification.registrationInfo;
  const label = input.label.trim().slice(0, 80) || "Passkey";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_passkeys
         (credential_id, user_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [info.credential.id, input.userId, Buffer.from(info.credential.publicKey), info.credential.counter,
       info.credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp, label],
    );
    await client.query(
      `INSERT INTO user_mfa_settings(user_id) VALUES($1)
       ON CONFLICT (user_id) DO UPDATE SET version = user_mfa_settings.version + 1, updated_at = now()`,
      [input.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getMfaStatus(input.userId);
}

export async function beginPasskeyAuthentication(input: {
  userId: string; purpose: Exclude<PasskeyPurpose, "registration">; context: WebAuthnContext;
}): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const credentials = await loadCredentials(input.userId);
  if (!credentials.length) throw new MfaError("PASSKEY_NOT_ENROLLED");
  const options = await generateAuthenticationOptions({
    rpID: input.context.rpID,
    allowCredentials: credentials.map((key) => ({ id: key.id, transports: key.transports })),
    userVerification: "required",
  });
  return { challengeId: await saveChallenge(input.userId, input.purpose, options.challenge), options };
}

export async function finishPasskeyAuthentication(input: {
  userId: string; challengeId: string; purpose: Exclude<PasskeyPurpose, "registration">;
  response: AuthenticationResponseJSON; context: WebAuthnContext;
}): Promise<MfaStatus> {
  const challenge = await takeChallenge(input.userId, input.challengeId, input.purpose);
  const keyResult = await getPool().query<{
    public_key: Buffer; counter: string; transports: AuthenticatorTransportFuture[]; device_type: "singleDevice" | "multiDevice"; backed_up: boolean;
  }>(
    `SELECT public_key, counter, transports, device_type, backed_up
       FROM user_passkeys WHERE credential_id = $1 AND user_id = $2`,
    [input.response.id, input.userId],
  );
  const key = keyResult.rows[0];
  if (!key) throw new MfaError("PASSKEY_VERIFICATION_FAILED");
  const credential: WebAuthnCredential = {
    id: input.response.id,
    publicKey: new Uint8Array(key.public_key),
    counter: Number(key.counter),
    transports: key.transports,
  };
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: input.context.origin,
    expectedRPID: input.context.rpID,
    credential,
    requireUserVerification: true,
  }).catch(() => null);
  if (!verification?.verified) throw new MfaError("PASSKEY_VERIFICATION_FAILED");
  await getPool().query(
    `UPDATE user_passkeys SET counter = $3, device_type = $4, backed_up = $5, last_used_at = now()
      WHERE credential_id = $1 AND user_id = $2`,
    [input.response.id, input.userId, verification.authenticationInfo.newCounter,
     verification.authenticationInfo.credentialDeviceType, verification.authenticationInfo.credentialBackedUp],
  );
  return getMfaStatus(input.userId);
}

export async function updateMfaPolicies(input: {
  userId: string; loginRequired: boolean; historyRequired: boolean;
}): Promise<MfaStatus> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO user_mfa_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",
      [input.userId],
    );
    await client.query("SELECT user_id FROM user_mfa_settings WHERE user_id=$1 FOR UPDATE", [input.userId]);
    const count = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM user_passkeys WHERE user_id=$1",
      [input.userId],
    );
    if ((input.loginRequired || input.historyRequired) && !count.rows[0]?.count) {
      throw new MfaError("PASSKEY_NOT_ENROLLED");
    }
    await client.query(
      `UPDATE user_mfa_settings
          SET login_required=$2, history_required=$3, version=version+1, updated_at=now()
        WHERE user_id=$1`,
      [input.userId, input.loginRequired, input.historyRequired],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getMfaStatus(input.userId);
}

export async function deletePasskey(userId: string, credentialId: string): Promise<MfaStatus> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const settings = await client.query<{ login_required: boolean; history_required: boolean }>(
      "SELECT login_required, history_required FROM user_mfa_settings WHERE user_id=$1 FOR UPDATE", [userId],
    );
    const count = await client.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM user_passkeys WHERE user_id=$1", [userId]);
    if ((count.rows[0]?.count ?? 0) <= 1 && (settings.rows[0]?.login_required || settings.rows[0]?.history_required)) {
      throw new MfaError("PASSKEY_LAST_PROTECTED");
    }
    const removed = await client.query("DELETE FROM user_passkeys WHERE user_id=$1 AND credential_id=$2", [userId, credentialId]);
    if (!removed.rowCount) throw new MfaError("PASSKEY_NOT_FOUND");
    await client.query("UPDATE user_mfa_settings SET version=version+1, updated_at=now() WHERE user_id=$1", [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return getMfaStatus(userId);
}

export async function isCredentialMfaRequired(userId: string): Promise<boolean> {
  const result = await getPool().query<{ required: boolean }>(
    `SELECT (s.login_required AND EXISTS(SELECT 1 FROM user_passkeys p WHERE p.user_id=s.user_id)) AS required
       FROM user_mfa_settings s WHERE s.user_id=$1`, [userId],
  );
  return result.rows[0]?.required === true;
}

async function loadCredentials(userId: string): Promise<WebAuthnCredential[]> {
  const result = await getPool().query<{ credential_id: string; public_key: Buffer; counter: string; transports: AuthenticatorTransportFuture[] }>(
    "SELECT credential_id, public_key, counter, transports FROM user_passkeys WHERE user_id=$1", [userId],
  );
  return result.rows.map((row) => ({ id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports }));
}

async function saveChallenge(userId: string, purpose: PasskeyPurpose, challenge: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO user_passkey_challenges(user_id,purpose,challenge,expires_at)
     VALUES($1,$2,$3,now()+($4 * interval '1 millisecond')) RETURNING id`,
    [userId, purpose, challenge, CHALLENGE_TTL_MS],
  );
  return result.rows[0]!.id;
}

async function takeChallenge(userId: string, id: string, purpose: PasskeyPurpose): Promise<string> {
  const result = await getPool().query<{ challenge: string }>(
    `DELETE FROM user_passkey_challenges
      WHERE id=$1 AND user_id=$2 AND purpose=$3 AND expires_at>now() RETURNING challenge`,
    [id, userId, purpose],
  );
  if (!result.rows[0]) throw new MfaError("PASSKEY_CHALLENGE_EXPIRED");
  return result.rows[0].challenge;
}
