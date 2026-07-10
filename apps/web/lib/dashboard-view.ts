// 대시보드 뷰 선택 — 다크모드·브랜드 색과 같은 기기 단위 개인 설정.
// 쿠키(VIEW_COOKIE)에 뷰 키를 저장하고 페이지가 SSR 에서 분기한다(깜빡임 없음).
// 클라이언트(툴바 토글)와 서버(페이지)가 함께 임포트하므로 next/headers 는 여기 두지 않는다.

export const VIEW_COOKIE = "toard.view";

export const DASHBOARD_VIEWS = ["overview", "classic"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const DEFAULT_VIEW: DashboardView = "overview";

export function isDashboardView(v: unknown): v is DashboardView {
  return typeof v === "string" && (DASHBOARD_VIEWS as readonly string[]).includes(v);
}
