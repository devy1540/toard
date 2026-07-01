import bcrypt from "bcryptjs";

// bcrypt 라운드. 로그인/가입 시에만 수행되므로 12(권장 상한)로 여유 있게.
const ROUNDS = 12;

/**
 * 존재하지 않는/OAuth 전용 사용자에 대해서도 동일하게 비교를 수행해 응답 시간 차를 줄이는
 * 고정 더미 해시 (사용자 열거 완화). 어떤 평문과도 일치하지 않는다.
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$1ddffOeTgwObZDBQVoPE4ul4Fe9XW7p389TVVR1T0bh3JxT5Pcp/u";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 비밀번호 정책. 통과 시 null, 위반 시 사용자용 한국어 메시지. */
export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "비밀번호는 최소 8자 이상이어야 합니다.";
  if (pw.length > 200) return "비밀번호가 너무 깁니다 (최대 200자).";
  return null;
}
