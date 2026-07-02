import { redirect } from "next/navigation";

// 내 사용량이 랜딩(/)으로 승격됨 — 기존 링크 호환용 리다이렉트.
export default function MeRedirect(): never {
  redirect("/");
}
