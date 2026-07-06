"use server";

import { auth } from "@/auth";
import { getLatestShimVersion } from "@/lib/host-shims";
import { getActiveTokenMeta } from "@/lib/tokens";

export type IngestStatus = {
  hasToken: boolean;
  lastUsedAt: string | null;
  shimVersion: string | null;
};

/** 설치 탭 "연결 확인" 폴링용 — 내 활성 토큰의 마지막 수신 시각(수집 요청마다 갱신됨). */
export async function checkIngestStatusAction(): Promise<IngestStatus> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { hasToken: false, lastUsedAt: null, shimVersion: null };

  const [meta, shimVersion] = await Promise.all([
    getActiveTokenMeta(userId),
    getLatestShimVersion(userId),
  ]);
  return {
    hasToken: Boolean(meta),
    lastUsedAt: meta?.lastUsedAt?.toISOString() ?? null,
    shimVersion,
  };
}
