/**
 * 인증 정책 (도메인 제한·이메일 형식). auth.ts(로그인)와 signup(가입) 이 공유해
 * 동일한 규칙을 적용한다. 여기에는 외부 의존성을 두지 않는다(엣지·서버 어디서나 안전).
 */

/** 허용 이메일 도메인 (ALLOWED_EMAIL_DOMAINS, 콤마 구분). 빈 배열이면 제한 없음. */
export const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** 이메일 도메인이 허용 목록에 있는지 (제한 없으면 항상 true). 정확 일치(서브도메인 모호성 제거). */
export function isEmailDomainAllowed(email: string): boolean {
  if (allowedDomains.length === 0) return true;
  return allowedDomains.includes(email.toLowerCase().split("@").pop() ?? "");
}

/** 최소한의 이메일 형식 검사 (서버측 1차 방어 — 브라우저 type=email 과 별개). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
