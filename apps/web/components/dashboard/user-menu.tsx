import Link from "next/link";
import { auth, credentialsEnabled, oauthConfigured, signOut } from "@/auth";
import { Button } from "@/components/ui/button";

/**
 * 헤더 사용자 메뉴 (server component).
 *  - 로그인됨: 이메일 + 로그아웃
 *  - 로그인 수단(OAuth 또는 id/pw) 있음 + 미로그인: 로그인 버튼 → /login
 *  - 로그인 수단 없음(dev 폴백): 표시 없음
 */
export async function UserMenu() {
  const session = await auth();
  const email = session?.user?.email;

  if (email) {
    return (
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
        className="flex items-center gap-2"
      >
        <span className="text-muted-foreground hidden text-sm sm:inline">{email}</span>
        <Button type="submit" variant="outline" size="sm">
          로그아웃
        </Button>
      </form>
    );
  }

  if (!oauthConfigured && !credentialsEnabled) return null;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/login">로그인</Link>
    </Button>
  );
}
