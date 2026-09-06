import assert from "node:assert/strict";
import test from "node:test";
import { calculateTokenCost, explainCostAt } from "./cost";
import { fromLiteLLM, pricingDetails } from "./sync";

// Official token rates checked 2026-09-06. Synthetic requests, never user logs.
// https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-pro
// https://developers.openai.com/api/docs/models/gpt-5.4
// LiteLLM field names: github.com/BerriAI/litellm/model_prices_and_context_window.json
const pricing = fromLiteLLM({
  "gemini-2.5-pro": {
    input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6,
    input_cost_per_token_above_200k_tokens: 2.5e-6, output_cost_per_token_above_200k_tokens: 15e-6,
    cache_read_input_token_cost: 0.125e-6, cache_read_input_token_cost_above_200k_tokens: 0.25e-6,
  },
  "gpt-5.4": {
    input_cost_per_token: 2.5e-6, output_cost_per_token: 15e-6,
    input_cost_per_token_above_272k_tokens: 5e-6, output_cost_per_token_above_272k_tokens: 22.5e-6,
    cache_read_input_token_cost: 0.25e-6, cache_read_input_token_cost_above_272k_tokens: 0.5e-6,
  },
});

const base = { outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
const near = (actual: number | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("Gemini 300k input + 10k output costs $0.90, never graduated $0.60", () => {
  const result = calculateTokenCost({ ...base, model: "gemini-2.5-pro", inputTokens: 300_000 }, pricing.get("gemini-2.5-pro")!);
  near(result?.totalUsd, 0.90);
  near(result?.componentsUsd.input, 0.75);
  near(result?.componentsUsd.output, 0.15);
});

test("the 200k boundary includes cached tokens and changes all applicable rates", () => {
  const price = pricing.get("gemini-2.5-pro")!;
  near(calculateTokenCost({ ...base, model: "gemini-2.5-pro", inputTokens: 200_000 }, price)?.totalUsd, 0.35);
  near(calculateTokenCost({ ...base, model: "gemini-2.5-pro", inputTokens: 200_001 }, price)?.totalUsd, 0.6500025);
  const cached = calculateTokenCost({ ...base, model: "gemini-2.5-pro", inputTokens: 100_000, cacheReadTokens: 201_000 }, price);
  assert.equal(cached?.contextTokens, 301_000);
  near(cached?.totalUsd, 0.45025);
  assert.equal(cached?.ratesPerMillion.cacheRead, 0.25);
});

test("272k metadata is preserved; request-local GPT session pricing is marked estimated", () => {
  const price = pricing.get("gpt-5.4")!;
  assert.equal(pricingDetails(price).contextTiers?.[0]?.aboveTokens, 272_000);
  const result = explainCostAt({
    ...base, model: "gpt-5.4", inputTokens: 300_000,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    schedule: new Map([["gpt-5.4", [{ id: "fixture", modelId: "gpt-5.4", effectiveAt: new Date(0), pricing: price }]]]),
  });
  near(result.resolution.costUsd, 1.725);
  assert.equal(result.resolution.status, "estimated");
  assert.equal(result.reason, "session_context_unavailable");
  assert.equal(result.calculationVersion, "cost-v2");
});

test("unknown cache pricing is not replaced with another provider's ratios", () => {
  const result = explainCostAt({
    ...base, model: "unknown-provider", inputTokens: 100, cacheReadTokens: 100,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    schedule: new Map([["unknown-provider", [{ id: "fixture", modelId: "unknown-provider", effectiveAt: new Date(0), pricing: { inputPerM: 2, outputPerM: 3 } }]]]),
  });
  assert.equal(result.resolution.status, "unpriced");
  assert.equal(result.reason, "missing_rate");
});

test("an inferred model never receives the same confidence as an exact identity", () => {
  const price = pricing.get("gemini-2.5-pro")!;
  const result = explainCostAt({
    ...base, model: "unrecognized-gemini-2.5-pro-variant", inputTokens: 50,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    schedule: new Map([["gemini-2.5-pro", [{ id: "fixture", modelId: "gemini-2.5-pro", effectiveAt: new Date(0), pricing: price }]]]),
  });
  assert.equal(result.resolution.status, "estimated");
  assert.equal(result.modelMatch, "inferred");
});

test("a default fast multiplier cannot silently confirm a base-rate fast request", () => {
  const result = explainCostAt({
    ...base, model: "claude-test", inputTokens: 100, isFast: true,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    schedule: new Map([["claude-test", [{ id: "known-price", modelId: "claude-test", effectiveAt: new Date(0), pricing: { inputPerM: 3, outputPerM: 15, fastMultiplier: 1 } }]]]),
  });
  assert.equal(result.resolution.status, "unpriced");
  assert.equal(result.reason, "missing_rate");
  assert.equal(result.resolution.pricingRevisionId, "known-price", "keep the available price evidence even when a required tariff is missing");
});
