import { NextResponse } from "next/server";

// Liveness: 프로세스가 살아있으면 200 (의존성 검사 없음 — DB 장애로 재시작 루프 방지).
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
