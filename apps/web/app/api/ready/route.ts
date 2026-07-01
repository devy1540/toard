import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

// Readiness: DB 연결 가능할 때만 200 (아니면 503 → 트래픽 차단). K8s readinessProbe 용.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  }
}
