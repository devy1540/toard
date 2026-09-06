import assert from "node:assert/strict";
import test from "node:test";
import type { FinalizedUsageEvent } from "@toard/core";
import { buildWeeklyReport, reportGenerationKey } from "./weekly-report";
import { reportPeriod } from "./report-period";
import type { CostEvidenceRevision } from "./cost-evidence";
import { weeklyReportCsv } from "./report-csv";

const state = { personalUserGeneration: 1, personalUserPending: 0, personalAllGeneration: 2, personalAllPending: 0, organizationGeneration: 3, organizationPending: 0 };
const period = reportPeriod("2026-08-30", "UTC", new Date("2026-09-06T12:00:00Z"));
const revision: CostEvidenceRevision = { id: "price", modelId: "fixture", effectiveAt: new Date("2026-01-01T00:00:00Z"), source: "fixture-source", sourceRef: null, pricing: { inputPerM: 1, outputPerM: 2, fastMultiplier: 1 } };
const event: FinalizedUsageEvent = { dedupKey: "event", userId: "owner", providerKey: "fixture", model: "fixture", sessionId: "private-session", host: "private-device",
  ts: period.current.from, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1, costStatus: "priced", pricingRevisionId: "price", costCalculationVersion: "cost-v2" };
const health = { checkedAt: "2026-09-06T00:00:00Z", connections: 0, unconfirmed: 0, noReport: 0, errors: 0, paused: 0, stale: 0, pendingEvents: null, outboxPending: 0 };

test("prices are loaded before streaming, ongoing unrelated activity does not prevent a complete report", async () => {
  let pricesLoaded = false;
  const report = await buildWeeklyReport({ kind: "user", userId: "owner" }, period, {
    revisionIds: async () => ["price", "unused"],
    readRevisions: async () => { pricesLoaded = true; return new Map([["price", revision], ["unused", { ...revision, id: "unused", source: "not-in-report" }]]); },
    consume: async (_scope, _query, consume) => { assert.equal(pricesLoaded, true); await consume([event]); },
    generation: async () => ({ ...state, personalUserPending: 1 }),
  });
  assert.equal(report.current.costUsd, 1);
  assert.equal(report.updatesDuringBuild, true);
  assert.equal(report.evidence.length, 1);
  assert.equal(JSON.stringify(report).includes("private-session"), false);
  assert.equal(JSON.stringify(report).includes("private-device"), false);
  assert.equal(JSON.stringify(report).includes("not-in-report"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).period, report.period, "cached reports do not depend on Date prototypes");
});

test("a failed stream never returns a partial report or retries its consumed prefix", async () => {
  let calls = 0;
  await assert.rejects(buildWeeklyReport({ kind: "user", userId: "owner" }, period, {
    revisionIds: async () => ["price"], readRevisions: async () => new Map([["price", revision]]), generation: async () => state,
    consume: async (_scope, _query, consume) => { calls++; await consume([event]); throw new Error("stream_failed"); },
  }), /stream_failed/);
  assert.equal(calls, 1);
});

test("foreign personal evidence is rejected and unavailable prices stay blank in CSV model amounts", async () => {
  const deps = { revisionIds: async () => [], readRevisions: async () => new Map(), generation: async () => state };
  await assert.rejects(buildWeeklyReport({ kind: "user", userId: "owner" }, period, {
    ...deps, consume: async (_scope, _query, consume) => { await consume([{ ...event, userId: "someone-else" }]); },
  }), /outside_scope/);
  const report = await buildWeeklyReport({ kind: "user", userId: "owner" }, period, {
    ...deps, consume: async (_scope, _query, consume) => { await consume([{ ...event, costStatus: "unpriced", costUsd: 0, model: "=unsafe", pricingRevisionId: null }]); },
  });
  const csv = weeklyReportCsv(report, health);
  const row = csv.split("\r\n").find(line => line.startsWith('"model"') && line.includes('"costUsd"'))!;
  assert.match(row, /"costUsd",,,,"USD_API_EQUIVALENT"/);
  assert.ok(row.includes("unpriced_current=1"));
  assert.ok(row.includes('"\'=unsafe"'));
});

test("cache generations are scoped and pending work disables caching", () => {
  assert.equal(reportGenerationKey({ kind: "user", userId: "owner" }, state), "1:2");
  assert.equal(reportGenerationKey({ kind: "organization" }, state), "3");
  assert.equal(reportGenerationKey({ kind: "team", teamId: "team" }, { ...state, organizationPending: 1 }), null);
});
