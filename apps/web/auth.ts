import PostgresAdapter from "@auth/pg-adapter";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { getPool } from "@/lib/db";

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 자격(AUTH_*_ID/SECRET)이 설정된 provider 만 활성화 — 환경별 구성(ADR-007).
const providers: Provider[] = [];
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) providers.push(GitHub);
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google);

/** 활성 OAuth provider 가 하나라도 있으면 true (dev 폴백 비활성 판단에 사용) */
export const oauthConfigured = providers.length > 0;

// Auth.js (ADR-007) — 자체 PG 세션. 메타·인증은 항상 PG(ADR-003).
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(getPool()),
  session: { strategy: "database" },
  providers,
  callbacks: {
    // 이메일 도메인 제한 (검증된 identity 기반 — 설계 §10.4)
    signIn({ user }) {
      if (allowedDomains.length === 0) return true;
      const email = user.email ?? "";
      return allowedDomains.some((d) => email.endsWith(`@${d}`));
    },
  },
});
