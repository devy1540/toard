import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function repoSource(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function messageShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return typeof value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, messageShape(nested)]),
  );
}

test("개인 활용 지수 UI는 자기 기준 점수·신뢰도·세부 축만 표시한다", () => {
  const page = source("app/(dashboard)/insights/page.tsx");
  const card = source("components/dashboard/utilization-index-card.tsx");

  assert.match(page, /getCachedPersonalUtilization\(userId\)/);
  assert.match(page, /Promise\.all/);
  assert.match(card, /methodologyVersion/);
  assert.match(card, /confidence/);
  assert.match(card, /dimension\.currentValue/);
  assert.doesNotMatch(card, /prompt_records|contentCollection|TOARD_SHIM_COLLECT_CONTENT/);
  assert.doesNotMatch(card, /ranking|rank|productivity/i);
});

test("개인 활용 지수 한영 메시지는 산식 상태 전체를 같은 구조로 제공한다", () => {
  const ko = JSON.parse(source("messages/ko/insights.json"));
  const en = JSON.parse(source("messages/en/insights.json"));
  assert.deepEqual(messageShape(ko.utilization), messageShape(en.utilization));
  for (const key of [
    "insufficient_current_days",
    "insufficient_current_sessions",
    "insufficient_baseline_days",
    "unsupported_cache_signal",
    "insufficient_context_days",
    "insufficient_known_tool_calls",
    "low_tool_outcome_coverage",
    "insufficient_session_tool_calls",
    "insufficient_valid_dimensions",
  ]) {
    assert.equal(typeof ko.utilization.reasons[key], "string");
  }
});

test("개인과 조직 활용 지수 카드는 제목 옆에 outline 실험 태그를 표시한다", () => {
  const personal = source("components/dashboard/utilization-index-card.tsx");
  const organization = source("components/dashboard/org-utilization-card.tsx");
  const badgePattern = /<Badge variant="outline">\{t\("utilization\.experiment"\)\}<\/Badge>/g;

  assert.equal(personal.match(badgePattern)?.length, 1);
  assert.equal(organization.match(badgePattern)?.length, 3);
  assert.match(personal, /<Badge variant="secondary">\{t\(`utilization\.confidence\./);
});

test("활용 지수 실험 태그는 한국어와 영어 문구를 제공한다", () => {
  const koInsights = JSON.parse(source("messages/ko/insights.json"));
  const enInsights = JSON.parse(source("messages/en/insights.json"));
  const koOrg = JSON.parse(source("messages/ko/org.json"));
  const enOrg = JSON.parse(source("messages/en/org.json"));

  assert.equal(koInsights.utilization.experiment, "실험");
  assert.equal(enInsights.utilization.experiment, "Experimental");
  assert.equal(koOrg.utilization.experiment, "실험");
  assert.equal(enOrg.utilization.experiment, "Experimental");
  assert.deepEqual(messageShape(koOrg.utilization), messageShape(enOrg.utilization));
});

test("조직 활용 지수 UI는 최소 표본을 지키고 개인 식별자를 받지 않는다", () => {
  const page = source("app/(dashboard)/org/page.tsx");
  const card = source("components/dashboard/org-utilization-card.tsx");
  const ko = source("messages/ko/org.json");
  const en = source("messages/en/org.json");

  assert.match(page, /getCachedOrganizationUtilization\(\)/);
  assert.match(card, /result\.state === "suppressed"/);
  assert.doesNotMatch(card, /userId|email|individualScores|leaderboard/i);
  assert.match(ko, /활성 사용자 5명/);
  assert.match(en, /5 active users/);
});

test("활용 지수 코드와 문서는 콘텐츠 비수집·방법론·최소 표본 계약을 유지한다", () => {
  const service = source("lib/ai-utilization.ts");
  const methodology = repoSource("docs/ai-utilization-methodology.md");
  const policy = repoSource("docs/ai-utilization-policy.md");

  for (const forbidden of ["prompt_records", "content_ciphertext", "turn_role"]) {
    assert.equal(service.includes(forbidden), false);
  }
  assert.match(methodology, /utilization-v1/);
  assert.match(policy, /활성 사용자가 5명/);
});
