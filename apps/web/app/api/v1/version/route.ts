import { getServerVersion } from "@/lib/version";

// 서버 버전 노출 — 배포 확인(운영자)·향후 doctor 의 호환성 자가진단용. 공개 엔드포인트.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(
    { version: getServerVersion() },
    { headers: { "cache-control": "no-store" } },
  );
}
