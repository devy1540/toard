// 뷰어 타임존 (ADR-008 개정) — 대시보드 표출(기간 경계·버킷·시각 포맷)의 기준 타임존.
// 우선순위: 사용자 설정(users.timezone) → 브라우저 쿠키(TimezoneSync 가 기록) → 조직 타임존.
// Mart 물질화·cron 마감은 계속 조직 타임존(org-time.ts) — 여기는 읽기(표출) 전용.

import { cache } from "react";
import { cookies } from "next/headers";
import { getCurrentUserId } from "./current-user";
import { getPool } from "./db";
import { getOrgTimezone } from "./org-time";
import { activateTimezoneRollupNonBlocking, resolveSupportedRollupTimezone } from "./timezone-rollup";

/** TimezoneSync(클라이언트)가 기록하는 브라우저 타임존 쿠키. 값은 raw IANA 이름. */
export const TZ_COOKIE = "toard.tz";

export async function resolveViewerTimezoneWith(args: {
  savedTimezone: string | null;
  cookieTimezone: string | null;
  orgTimezone: string;
  resolveTimezone: (timezone: string) => Promise<string | null>;
  activate: (timezone: string) => void;
}): Promise<string> {
  for (const candidate of [
    args.savedTimezone,
    args.cookieTimezone,
    args.orgTimezone,
    "UTC",
  ]) {
    if (!candidate) continue;
    const resolved = await args.resolveTimezone(candidate);
    if (!resolved) continue;
    args.activate(resolved);
    return resolved;
  }
  return "UTC";
}

/** 뷰어 타임존 — 요청(렌더) 단위로 캐시되어 페이지·컴포넌트 어디서 불러도 1회만 해석. */
export const getViewerTimezone = cache(async (): Promise<string> => {
  const userId = await getCurrentUserId();
  let savedTimezone: string | null = null;
  if (userId) {
    const r = await getPool().query<{ timezone: string | null }>(
      "SELECT timezone FROM users WHERE id = $1",
      [userId],
    );
    savedTimezone = r.rows[0]?.timezone ?? null;
  }

  return resolveViewerTimezoneWith({
    savedTimezone,
    cookieTimezone: (await cookies()).get(TZ_COOKIE)?.value ?? null,
    orgTimezone: getOrgTimezone(),
    resolveTimezone: resolveSupportedRollupTimezone,
    activate: activateTimezoneRollupNonBlocking,
  });
});
