import type { DailyPoint, LeaderRow, TeamMemberTimeseriesPoint } from "@toard/core";
import { totalUsageTokens } from "./org-overview";

export const TEAM_MEMBER_COLORS = ["#f4511e", "#2563eb", "#16a34a", "#9333ea", "#0f766e"] as const;

export type TeamMemberSeriesPoint = {
  day: string;
  costUsd: number;
  totalTokens: number;
};

export type TeamMemberSeries = {
  key: string;
  memberKey: string | null;
  label: string;
  color: string;
  points: TeamMemberSeriesPoint[];
};

function roundMetric(value: number): number {
  return Number(Math.max(0, value).toFixed(10));
}

/**
 * 집계 시리즈의 버킷을 기준으로 상위 구성원 시리즈를 보정하고, 보이지 않는 구성원의
 * 사용량은 하나의 기타 시리즈로 접는다. 선택된 구성원은 저장소에서만 조회한다.
 */
export function buildTeamMemberSeries(
  aggregate: DailyPoint[],
  memberPoints: TeamMemberTimeseriesPoint[],
  members: LeaderRow[],
  activeUsers: number,
  othersLabel: string,
): TeamMemberSeries[] {
  const byUserAndDay = new Map<string, Map<string, TeamMemberTimeseriesPoint>>();
  for (const point of memberPoints) {
    const byDay = byUserAndDay.get(point.userId) ?? new Map<string, TeamMemberTimeseriesPoint>();
    byDay.set(point.day, point);
    byUserAndDay.set(point.userId, byDay);
  }

  const selected = members.map((member, index) => {
    const byDay = byUserAndDay.get(member.key);
    return {
      key: `member-${index}`,
      memberKey: member.key,
      label: member.label,
      color: TEAM_MEMBER_COLORS[index % TEAM_MEMBER_COLORS.length] ?? TEAM_MEMBER_COLORS[0],
      points: aggregate.map((bucket) => {
        const point = byDay?.get(bucket.day);
        return {
          day: bucket.day,
          costUsd: point?.costUsd ?? 0,
          totalTokens: point ? totalUsageTokens({
            input: point.inputTokens,
            output: point.outputTokens,
            cacheRead: point.cacheReadTokens,
            cacheCreation: point.cacheCreationTokens,
          }) : 0,
        };
      }),
    } satisfies TeamMemberSeries;
  });

  if (activeUsers <= members.length) return selected;

  const others = aggregate.map((bucket, bucketIndex) => {
    const selectedCost = selected.reduce((sum, member) => sum + member.points[bucketIndex]!.costUsd, 0);
    const selectedTokens = selected.reduce((sum, member) => sum + member.points[bucketIndex]!.totalTokens, 0);
    return {
      day: bucket.day,
      costUsd: roundMetric(bucket.costUsd - selectedCost),
      totalTokens: roundMetric(totalUsageTokens({
        input: bucket.inputTokens,
        output: bucket.outputTokens,
        cacheRead: bucket.cacheReadTokens,
        cacheCreation: bucket.cacheCreationTokens,
      }) - selectedTokens),
    };
  });

  return [
    ...selected,
    {
      key: "others",
      memberKey: null,
      label: othersLabel,
      color: "#64748b",
      points: others,
    },
  ];
}
