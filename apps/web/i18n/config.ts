// 지원 로케일 정의 및 감지 유틸. 라우팅은 URL 접두사 없이 쿠키 기반 —
// 미로그인/최초 방문은 Accept-Language(시스템 언어)를 따르고, 미지원 언어는 defaultLocale 로 폴백.

export const locales = ["en", "ko"] as const;
export type Locale = (typeof locales)[number];

/** 지원하지 않는 시스템 언어일 때의 최종 폴백 (오픈소스 범용 지향 → 영어). */
export const defaultLocale: Locale = "en";

/** 로케일을 저장하는 쿠키 이름. next-intl 라우팅 관례와 동일 명칭 사용. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** 언어 스위처에 노출할 표시 이름 (각 언어의 자기 명칭). */
export const localeNames: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Accept-Language 헤더에서 지원 로케일을 협상한다.
 * `ko-KR,ko;q=0.9,en;q=0.8` 같은 값을 q 가중치 내림차순으로 훑어 첫 매치를 반환.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const segments = part.trim().split(";");
      const tag = (segments[0] ?? "").trim().toLowerCase();
      const q = segments.find((p) => p.trim().startsWith("q="));
      const quality = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    const match = locales.find((l) => l === tag || l === base);
    if (match) return match;
  }
  return defaultLocale;
}
