import assert from "node:assert/strict";
import test from "node:test";
import { decodeCostCursor, encodeCostCursor, explainStoredCost, type CostEvidenceRevision } from "./cost-evidence";
import type { FinalizedUsageEvent } from "@toard/core";

test("cost ledger cursor round-trips and rejects malformed timestamps", () => {
  const cursor = { ts: new Date("2026-09-05T12:00:00Z"), dedupKey: "event-1" };
  assert.deepEqual(decodeCostCursor(encodeCostCursor(cursor)), cursor);
  assert.equal(decodeCostCursor("garbage"), undefined);
  assert.equal(decodeCostCursor(Buffer.from(JSON.stringify({ ts: "invalid", dedupKey: "x" })).toString("base64url")), undefined);
});

test("legacy or mismatching amounts are never presented as a reproduced v2 calculation", () => {
  const revision: CostEvidenceRevision = { id: "rev", modelId: "model-a", effectiveAt: new Date(0), source: "fixture", sourceRef: null, pricing: { inputPerM: 1, outputPerM: 1 } };
  const event: FinalizedUsageEvent = { dedupKey: "key", providerKey: "fixture", model: "model-a", userId: "owner", sessionId: null, ts: new Date(), inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1, pricingRevisionId: "rev", costStatus: "priced", costCalculationVersion: "cost-v2" };
  assert.equal(explainStoredCost(event, revision)?.breakdown?.totalUsd, 1);
  assert.equal(explainStoredCost({ ...event, costCalculationVersion: "cost-v1" }, revision), null);
  assert.equal(explainStoredCost({ ...event, costUsd: 2 }, revision), null);
  assert.equal(explainStoredCost({ ...event, costStatus: "unpriced" }, revision), null);
});
