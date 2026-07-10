import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, isLocale, negotiateLocale, type Locale } from "./config";

/**
 * 요청별 로케일·메시지 해석.
 * 우선순위: NEXT_LOCALE 쿠키(사용자가 명시 선택) → Accept-Language(시스템 언어) → defaultLocale.
 */
export async function resolveLocale(): Promise<Locale> {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;
  return negotiateLocale((await headers()).get("accept-language"));
}

/** 로케일별 메시지를 영역 파일에서 조립. 영역 추가 시 이 목록에 등록. */
async function loadMessages(locale: Locale) {
  const [common, nav, auth, invite, dashboard, insights, org, settings, admin] = await Promise.all([
    import(`../messages/${locale}/common.json`),
    import(`../messages/${locale}/nav.json`),
    import(`../messages/${locale}/auth.json`),
    import(`../messages/${locale}/invite.json`),
    import(`../messages/${locale}/dashboard.json`),
    import(`../messages/${locale}/insights.json`),
    import(`../messages/${locale}/org.json`),
    import(`../messages/${locale}/settings.json`),
    import(`../messages/${locale}/admin.json`),
  ]);
  return {
    common: common.default,
    nav: nav.default,
    auth: auth.default,
    invite: invite.default,
    dashboard: dashboard.default,
    insights: insights.default,
    org: org.default,
    settings: settings.default,
    admin: admin.default,
  };
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return { locale, messages: await loadMessages(locale) };
});
