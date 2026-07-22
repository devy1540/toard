import PostgresAdapter from "@auth/pg-adapter";
import { randomUUID } from "node:crypto";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { isEmailDomainAllowed } from "@/lib/auth-policy";
import { resolveMfaSessionId } from "@/lib/auth-session";
import { getCredentialUserById, verifyCredentialUser } from "@/lib/credential-auth";
import { getPool } from "@/lib/db";
import { verifySignedMfaToken } from "@/lib/mfa";
import { isCredentialMfaRequired } from "@/lib/mfa-store";

// OAuth: 자격(AUTH_*_ID/SECRET)이 설정된 provider 만 활성화 — 환경별 구성(ADR-007).
const providers: Provider[] = [];
const oauthProviderIds: string[] = [];
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(GitHub);
  oauthProviderIds.push("github");
}
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google);
  oauthProviderIds.push("google");
}

/** 활성 OAuth provider 가 하나라도 있으면 true (dev 폴백·로그인 버튼 표시 판단). */
export const oauthConfigured = oauthProviderIds.length > 0;
/** 활성 OAuth provider id 목록 (로그인 페이지 버튼 렌더용). */
export const oauthProviders = oauthProviderIds;

// credentials(id/pw): 기본 활성. AUTH_CREDENTIALS_ENABLED=false 로 OAuth 전용 구성 가능(ADR-007).
export const credentialsEnabled = (process.env.AUTH_CREDENTIALS_ENABLED ?? "true") !== "false";
if (credentialsEnabled) {
  providers.push(
    Credentials({
      credentials: { email: {}, password: {}, loginTicket: {} },
      authorize: async (creds) => {
        const loginTicket = String(creds?.loginTicket ?? "");
        if (loginTicket) {
          const ticket = verifySignedMfaToken(loginTicket, "credential-ticket");
          const user = ticket ? await getCredentialUserById(ticket.userId) : null;
          return user ? { ...user, mfaSessionId: ticket!.nonce } : null;
        }
        const user = await verifyCredentialUser(String(creds?.email ?? ""), String(creds?.password ?? ""));
        if (!user || (await isCredentialMfaRequired(user.id))) return null;
        return user;
      },
    }),
  );
}

// Auth.js (ADR-007) — 메타·인증은 항상 PG(ADR-003). credentials 대비 JWT 세션.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(getPool()),
  // credentials(id/pw)는 database 세션 미지원 → JWT 세션.
  // 트레이드오프: 강제 로그아웃 즉시성은 토큰 만료/블랙리스트로 보완(백로그).
  session: { strategy: "jwt" },
  // 커스텀 로그인 페이지(OAuth 버튼 + id/pw 폼).
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    // 이메일 도메인 제한 (검증된 identity 기반 — 설계 §10.4).
    signIn({ user, account, profile }) {
      const email = (user.email ?? "").toLowerCase();
      if (!email) return false;
      // credentials 는 가입(도메인 게이팅)·seed(신뢰)에서 이미 검증됨. 로그인마다 재검사하면
      // 도메인 정책 변경 시 기존 계정(부트스트랩 admin 포함)이 잠기므로 스킵.
      if (account?.provider === "credentials") return true;
      // OAuth(새 identity 연합): 미검증 이메일 거부(도메인 사칭 방지) + 도메인 게이팅.
      if ((profile as { email_verified?: boolean } | undefined)?.email_verified === false) {
        return false;
      }
      return isEmailDomainAllowed(email);
    },
    // JWT 에 user.id 를 실어 세션에 노출 (database 세션이 아니므로 직접 전달)
    jwt({ token, user }) {
      if (user?.id) {
        token.uid = user.id;
      }
      const signInSessionId = user?.id
        ? (user as { mfaSessionId?: string }).mfaSessionId ?? randomUUID()
        : undefined;
      const mfaSessionId = resolveMfaSessionId(token, signInSessionId);
      if (mfaSessionId) token.mfaSid = mfaSessionId;
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") {
        session.user.id = token.uid;
      }
      if (typeof token.mfaSid === "string") session.mfaSessionId = token.mfaSid;
      return session;
    },
  },
});
