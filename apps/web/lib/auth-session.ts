import { createHash } from "node:crypto";

type MfaSessionToken = {
  mfaSid?: unknown;
  jti?: unknown;
  uid?: unknown;
  iat?: unknown;
};

/**
 * 기존 JWT에는 mfaSid가 없으므로 토큰의 세션별 식별자에서 안정적인 값을 파생한다.
 * uid만 사용하면 다른 로그인 세션까지 같은 값이 되므로 jti, 또는 uid+iat가 없으면
 * 값을 만들지 않고 새 로그인을 요구한다.
 */
export function resolveMfaSessionId(
  token: MfaSessionToken,
  signInSessionId?: string,
): string | undefined {
  if (signInSessionId) return signInSessionId;
  if (typeof token.mfaSid === "string" && token.mfaSid) return token.mfaSid;

  const legacyAnchor = typeof token.jti === "string" && token.jti
    ? `jti:${token.jti}`
    : typeof token.uid === "string" && token.uid && typeof token.iat === "number"
      ? `uid:${token.uid}:iat:${token.iat}`
      : undefined;
  if (!legacyAnchor) return undefined;

  return createHash("sha256")
    .update(`toard:mfa-session:${legacyAnchor}`)
    .digest("base64url");
}
