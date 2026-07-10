// next-intl 타입 안전 — 메시지 키/로케일을 컴파일 타임에 검증한다.
// 영역별 en 파일을 기준(source of truth)으로 Messages 형태를 조립.
import type { Locale } from "./config";
import type common from "../messages/en/common.json";
import type nav from "../messages/en/nav.json";
import type auth from "../messages/en/auth.json";
import type invite from "../messages/en/invite.json";
import type dashboard from "../messages/en/dashboard.json";
import type insights from "../messages/en/insights.json";
import type org from "../messages/en/org.json";
import type settings from "../messages/en/settings.json";
import type admin from "../messages/en/admin.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: {
      common: typeof common;
      nav: typeof nav;
      auth: typeof auth;
      invite: typeof invite;
      dashboard: typeof dashboard;
      insights: typeof insights;
      org: typeof org;
      settings: typeof settings;
      admin: typeof admin;
    };
  }
}
