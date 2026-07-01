import type { DefaultSession } from "next-auth";

// JWT 세션 전략에서 session.user.id / token.uid 를 노출하기 위한 타입 확장 (auth.ts 콜백과 정합).
declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}
