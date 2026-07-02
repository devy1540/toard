import { redirect } from "next/navigation";

// 설치는 설정의 탭으로 통합됨 — 기존 링크(초대 안내·문서 등) 호환용 리다이렉트.
export default function OnboardingRedirect(): never {
  redirect("/settings?tab=install");
}
