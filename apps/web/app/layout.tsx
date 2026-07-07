import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { BRAND_COOKIE, DEFAULT_BRAND, isBrandPreset } from "@/lib/brand";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    title: t("appName"),
    description: t("appDescription"),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  // 사용자 브랜드 색 — 쿠키로 SSR 첫 페인트부터 반영 (다크모드처럼 기기 단위 개인 설정).
  // 기본(coral)은 속성 생략 — 클라이언트 스위처(user-menu-dropdown)의 제거 동작과 일치.
  const brandCookie = (await cookies()).get(BRAND_COOKIE)?.value;
  const brand = isBrandPreset(brandCookie) && brandCookie !== DEFAULT_BRAND ? brandCookie : undefined;
  return (
    <html lang={locale} data-brand={brand} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {children}
            <Toaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
