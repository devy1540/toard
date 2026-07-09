import { NextResponse } from "next/server";
import { pingClickHouse } from "@toard/storage-clickhouse";
import { getPool } from "@/lib/db";

// Readiness: 실제 요청 처리에 필요한 DB 연결 가능할 때만 200 (아니면 503 → 트래픽 차단). K8s readinessProbe 용.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getPool().query("SELECT 1");
    if (process.env.STORAGE_BACKEND === "clickhouse") await pingClickHouse();
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  }
}
