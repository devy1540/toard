import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LogIn } from "lucide-react";
import { formatVersion } from "@toard/core";
import { auth, credentialsEnabled, oauthConfigured, signOut } from "@/auth";
import { UserMenuDropdown } from "@/components/dashboard/user-menu-dropdown";
import { Button } from "@/components/ui/button";
import { getServerVersion } from "@/lib/version";

/**
 * 사이드바 하단 사용자 메뉴 (server component).
 *  - 로그인됨: 계정 버튼 한 줄 → 드롭다운에 테마·언어·로그아웃·버전 수납
 *  - 로그인 수단(OAuth 또는 id/pw) 있음 + 미로그인: 로그인 버튼 + 환경 설정 드롭다운
 *  - 로그인 수단 없음(dev 폴백): 환경 설정 드롭다운만
 */
export async function UserMenu() {
  const session = await auth();
  const email = session?.user?.email;
  const t = await getTranslations("common");
  const version = formatVersion(getServerVersion());

  if (email) {
    return (
      <UserMenuDropdown
        email={email}
        version={version}
        signOutAction={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      />
    );
  }

  if (!oauthConfigured && !credentialsEnabled) {
    return (
      <div className="flex justify-end">
        <UserMenuDropdown version={version} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
      {/* 아이콘 collapse 폭(3rem)에는 못 들어가는 버튼 — 접힘 상태에선 숨기고 드롭다운만 남긴다 */}
      <Button asChild variant="outline" size="sm" className="flex-1 justify-start group-data-[collapsible=icon]:hidden">
        <Link href="/login">
          <LogIn className="size-4" />
          {t("signIn")}
        </Link>
      </Button>
      <UserMenuDropdown version={version} />
    </div>
  );
}
