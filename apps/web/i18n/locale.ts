"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, isLocale, type Locale } from "./config";
import { resolveLocale } from "./request";

/** 현재 요청의 활성 로케일 (쿠키 → Accept-Language → 기본). */
export async function getUserLocale(): Promise<Locale> {
  return resolveLocale();
}

/** 언어 스위처에서 호출 — 선택 로케일을 쿠키에 1년간 저장. */
export async function setUserLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
