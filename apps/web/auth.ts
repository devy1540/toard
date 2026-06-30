import PostgresAdapter from "@auth/pg-adapter";
import NextAuth from "next-auth";
import { getPool } from "@/lib/db";

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Auth.js (ADR-007) — 자체 PG 세션. providers 는 환경별로 추가(OAuth/이메일). 1차 골격.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(getPool()),
  session: { strategy: "database" },
  providers: [
    // 예: GitHub / Google OAuth 또는 이메일 OTP — 배포 환경에서 자격 추가
  ],
  callbacks: {
    // 이메일 도메인 제한 (검증된 identity 기반 — 설계 §10.4)
    signIn({ user }) {
      if (allowedDomains.length === 0) return true;
      const email = user.email ?? "";
      return allowedDomains.some((d) => email.endsWith(`@${d}`));
    },
  },
});
