import { type ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LogIn, LogOut } from "lucide-react";
import { auth, credentialsEnabled, oauthConfigured, signOut } from "@/auth";
import { Button } from "@/components/ui/button";

/**
 * 사이드바 하단 사용자 메뉴 (server component).
 *  - 로그인됨: 이메일 + 로그아웃
 *  - 로그인 수단(OAuth 또는 id/pw) 있음 + 미로그인: 로그인 버튼 → /login
 *  - 로그인 수단 없음(dev 폴백): 계정 버튼 없음
 * trailing: 계정 버튼과 같은 줄 오른쪽에 붙일 요소(테마 토글 등).
 */
export async function UserMenu({ trailing }: { trailing?: ReactNode }) {
  const session = await auth();
  const email = session?.user?.email;
  const t = await getTranslations("common");

  if (email) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground truncate px-2 text-xs" title={email}>
          {email}
        </span>
        <div className="flex items-center gap-2">
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
            className="flex-1"
          >
            <Button type="submit" variant="outline" size="sm" className="w-full justify-start">
              <LogOut className="size-4" />
              {t("signOut")}
            </Button>
          </form>
          {trailing}
        </div>
      </div>
    );
  }

  if (!oauthConfigured && !credentialsEnabled) {
    return trailing ? <div className="flex justify-end">{trailing}</div> : null;
  }

  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm" className="flex-1 justify-start">
        <Link href="/login">
          <LogIn className="size-4" />
          {t("signIn")}
        </Link>
      </Button>
      {trailing}
    </div>
  );
}
