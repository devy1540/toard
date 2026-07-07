"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ChevronsUpDown, Languages, LogOut, Moon, Palette, SlidersHorizontal, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isLocale, localeNames, locales } from "@/i18n/config";
import { setUserLocale } from "@/i18n/locale";
import {
  BRAND_COOKIE,
  BRAND_PRESETS,
  BRAND_SWATCHES,
  DEFAULT_BRAND,
  isBrandPreset,
  type BrandPreset,
} from "@/lib/brand";
import { cn } from "@/lib/utils";

/** 이메일 로컬파트에서 아바타 이니셜(최대 2자)을 뽑는다: hyukjun.yoon@… → HY */
function emailInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const second = parts[1]?.charAt(0) ?? "";
  return (second ? first + second : local.slice(0, 2)).toUpperCase() || "?";
}

/**
 * 사이드바 하단 계정 드롭다운 (client component).
 *  - email 있음: 아바타+이메일 트리거 → 테마·언어·로그아웃·버전 메뉴
 *  - email 없음: 환경 설정 아이콘 트리거 → 테마·언어·버전 메뉴
 */
export function UserMenuDropdown({
  email,
  version,
  signOutAction,
}: {
  email?: string;
  version: string;
  signOutAction?: () => Promise<void>;
}) {
  const { setTheme, resolvedTheme } = useTheme();
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // 브랜드 색 — html data-brand 가 진실(SSR 이 쿠키로 렌더). 마운트 후 읽어 하이라이트 동기화.
  const [brand, setBrand] = useState<BrandPreset>(DEFAULT_BRAND);
  useEffect(() => {
    const current = document.documentElement.dataset.brand;
    setBrand(isBrandPreset(current) ? current : DEFAULT_BRAND);
  }, []);

  function onBrandChange(next: BrandPreset) {
    document.cookie = `${BRAND_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // 즉시 반영(리렌더 전) + SSR 과 동일 규칙: 기본 프리셋은 속성 제거
    if (next === DEFAULT_BRAND) delete document.documentElement.dataset.brand;
    else document.documentElement.dataset.brand = next;
    setBrand(next);
    router.refresh();
  }

  function onLocaleChange(next: string) {
    if (!isLocale(next) || next === locale) return;
    startTransition(async () => {
      await setUserLocale(next);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {email ? (
          <Button
            variant="outline"
            className="h-auto w-full justify-start px-2 py-1.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          >
            <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium">
              {emailInitials(email)}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-left text-xs font-normal group-data-[collapsible=icon]:hidden"
              title={email}
            >
              {email}
            </span>
            <ChevronsUpDown className="text-muted-foreground size-3.5 group-data-[collapsible=icon]:hidden" />
          </Button>
        ) : (
          <Button variant="outline" size="icon" className="size-8" aria-label={t("preferences")}>
            <SlidersHorizontal className="size-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={email ? "start" : "end"}
        className={email ? "w-(--radix-dropdown-menu-trigger-width)" : undefined}
      >
        <DropdownMenuItem
          disabled={pending}
          onSelect={(e) => {
            // 메뉴를 닫지 않고 전환 — 바뀐 테마를 바로 확인할 수 있게
            e.preventDefault();
            setTheme(resolvedTheme === "dark" ? "light" : "dark");
          }}
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
          {t("theme")}
          <span className="text-muted-foreground ml-auto text-xs">
            {resolvedTheme === "dark" ? t("themeDark") : t("themeLight")}
          </span>
        </DropdownMenuItem>
        {/* 색상 — 스와치 클릭 시 즉시 적용, 메뉴는 닫지 않아 바로 비교 가능(테마 토글과 동일 UX) */}
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <Palette className="text-muted-foreground size-4" />
          {t("color")}
          <span className="ml-auto flex items-center gap-1">
            {BRAND_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-label={p}
                title={p}
                onClick={() => onBrandChange(p)}
                className={cn(
                  "size-4 rounded-full transition-transform hover:scale-110",
                  brand === p && "ring-ring ring-2 ring-offset-1",
                )}
                style={{ background: BRAND_SWATCHES[p] }}
              />
            ))}
          </span>
        </div>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={pending}>
            <Languages className="size-4" />
            {t("language")}
            <span className="text-muted-foreground flex-1 text-right text-xs">
              {isLocale(locale) ? localeNames[locale] : locale}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={locale} onValueChange={onLocaleChange}>
              {locales.map((l) => (
                <DropdownMenuRadioItem key={l} value={l}>
                  {localeNames[l]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {signOutAction ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                startTransition(async () => {
                  await signOutAction();
                })
              }
            >
              <LogOut className="size-4" />
              {t("signOut")}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        {/* 실행 중인 서버 버전(빌드 시 임베드) — 배포가 실제 반영됐는지 확인 */}
        <DropdownMenuLabel className="text-muted-foreground py-1 font-mono text-xs font-normal">
          {version}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
