import assert from "node:assert/strict";
import test from "node:test";
import type { DailyPoint, LeaderRow, TeamMemberTimeseriesPoint } from "@toard/core";
import { buildTeamMemberSeries } from "./team-overview";

function daily(day: string, tokens: number): DailyPoint {
  return {
    day,
    sessions: 1,
    activeUsers: 1,
    costUsd: tokens / 100,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function leader(key: string, label: string, tokens: number): LeaderRow {
  return { key, label, totalTokens: tokens, costUsd: tokens / 100, sessions: 1 };
}

function memberPoint(userId: string, day: string, tokens: number): TeamMemberTimeseriesPoint {
  return { userId, ...daily(day, tokens) };
}

test("team member series fills missing buckets for each ranked member", () => {
  const result = buildTeamMemberSeries(
    [daily("2026-07-06", 100), daily("2026-07-07", 80)],
    [memberPoint("u1", "2026-07-06", 40)],
    [leader("u1", "Dave", 40)],
    1,
    "Others",
  );

  assert.deepEqual(result, [
    {
      key: "member-0",
      memberKey: "u1",
      label: "Dave",
      color: "#f4511e",
      points: [
        { day: "2026-07-06", costUsd: 0.4, totalTokens: 40 },
        { day: "2026-07-07", costUsd: 0, totalTokens: 0 },
      ],
    },
  ]);
});

test("team member series folds usage outside the displayed members into others", () => {
  const result = buildTeamMemberSeries(
    [daily("2026-07-06", 100), daily("2026-07-07", 80)],
    [memberPoint("u1", "2026-07-06", 40), memberPoint("u1", "2026-07-07", 30)],
    [leader("u1", "Dave", 70)],
    2,
    "Others",
  );

  assert.deepEqual(result.at(-1), {
    key: "others",
    memberKey: null,
    label: "Others",
    color: "#64748b",
    points: [
      { day: "2026-07-06", costUsd: 0.6, totalTokens: 60 },
      { day: "2026-07-07", costUsd: 0.5, totalTokens: 50 },
    ],
  });
});
