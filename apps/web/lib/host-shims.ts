import { compareSemver } from "@toard/core";
import { getPool } from "./db";

// 기기별 shim 버전 기록/조회 (host_shims — 마이그레이션 1700000013).
// 수집 요청 User-Agent 에서 파싱한 버전을 (user, host) 단위로 남겨, 자동 업데이트가
// 침묵 실패로 멈춘 기기를 화면에서 식별한다. 순수 관측 — 수집 정합성과 무관.

export type HostShimRow = { userId: string; host: string; shimVersion: string; lastSeenAt: Date };

/** 배치 하나는 한 기기에서 오므로, 배치 내 host 전부에 요청 UA 의 버전을 귀속시킨다 */
export async function recordShimVersions(
  userId: string,
  version: string,
  hosts: Array<string | null | undefined>,
): Promise<void> {
  const uniq = [...new Set(hosts.filter((h): h is string => Boolean(h)))];
  if (uniq.length === 0) return;
  await getPool().query(
    `INSERT INTO host_shims (user_id, host, shim_version, last_seen_at)
     SELECT $1, unnest($2::text[]), $3, now()
     ON CONFLICT (user_id, host)
     DO UPDATE SET shim_version = EXCLUDED.shim_version, last_seen_at = EXCLUDED.last_seen_at`,
    [userId, uniq, version],
  );
}

/** 내 기기별 shim 버전 (설정 "내 기기" 표) */
export async function getHostShims(
  userId: string,
): Promise<Map<string, { version: string; lastSeenAt: Date }>> {
  const r = await getPool().query<{ host: string; shim_version: string; last_seen_at: Date }>(
    "SELECT host, shim_version, last_seen_at FROM host_shims WHERE user_id = $1",
    [userId],
  );
  return new Map(r.rows.map((x) => [x.host, { version: x.shim_version, lastSeenAt: x.last_seen_at }]));
}

/** 가장 최근에 수신한 기기의 버전 (연결 확인 카드) */
export async function getLatestShimVersion(userId: string): Promise<string | null> {
  const r = await getPool().query<{ shim_version: string }>(
    "SELECT shim_version FROM host_shims WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 1",
    [userId],
  );
  return r.rows[0]?.shim_version ?? null;
}

/** 전체 기기 rows (admin — 멤버별 최저 버전·구버전 배너) */
export async function listAllHostShims(): Promise<HostShimRow[]> {
  const r = await getPool().query<{
    user_id: string;
    host: string;
    shim_version: string;
    last_seen_at: Date;
  }>("SELECT user_id, host, shim_version, last_seen_at FROM host_shims");
  return r.rows.map((x) => ({
    userId: x.user_id,
    host: x.host,
    shimVersion: x.shim_version,
    lastSeenAt: x.last_seen_at,
  }));
}

/** 멤버별 최저(가장 뒤처진) 버전 — semver 순서는 사전순이 아니라 JS 에서 비교 */
export function worstShimByUser(rows: HostShimRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const cur = m.get(r.userId);
    if (!cur || compareSemver(r.shimVersion, cur) < 0) m.set(r.userId, r.shimVersion);
  }
  return m;
}
