"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const TZ_COOKIE = "toard.tz";

/**
 * 브라우저 타임존을 쿠키로 서버에 전달 — 서버 컴포넌트가 뷰어 타임존으로 기간 경계·버킷을
 * 계산한다(viewer-time.ts). 쿠키가 브라우저와 다를 때만 갱신 후 refresh(최초 방문·이동 직후
 * 1회). 사용자가 수동 타임존을 설정했으면 서버가 쿠키 대신 그 값을 쓴다.
 */
export function TimezoneSync() {
  const router = useRouter();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // IANA 이름 문자셋([A-Za-z0-9_+/-])은 쿠키 값으로 안전 — 인코딩 없이 raw 저장
    if (!tz || !/^[A-Za-z0-9_+/-]+$/.test(tz)) return;
    const current = document.cookie.match(/(?:^|;\s*)toard\.tz=([^;]*)/)?.[1];
    if (current === tz) return;
    document.cookie = `${TZ_COOKIE}=${tz}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [router]);
  return null;
}
