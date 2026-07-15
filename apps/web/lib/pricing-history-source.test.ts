import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubPricingHistorySource,
  PricingSourceRateLimitError,
} from "./pricing-history-source";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("GitHub 가격 이력 목록은 canonical 파일과 기간·page를 고정한다", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const source = new GitHubPricingHistorySource(async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return jsonResponse([{
      sha: "a".repeat(40),
      commit: { committer: { date: "2026-07-07T01:25:22Z" } },
    }]);
  });

  const commits = await source.listChanges(
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-08T00:00:00Z"),
    2,
  );

  assert.deepEqual(commits, [{
    sha: "a".repeat(40),
    committedAt: "2026-07-07T01:25:22.000Z",
  }]);
  assert.equal(requests[0]?.url.pathname, "/repos/BerriAI/litellm/commits");
  assert.equal(requests[0]?.url.searchParams.get("path"), "model_prices_and_context_window.json");
  assert.equal(requests[0]?.url.searchParams.get("since"), "2026-07-01T00:00:00.000Z");
  assert.equal(requests[0]?.url.searchParams.get("until"), "2026-07-08T00:00:00.000Z");
  assert.equal(requests[0]?.url.searchParams.get("per_page"), "100");
  assert.equal(requests[0]?.url.searchParams.get("page"), "2");
  assert.equal(requests[0]?.init?.signal instanceof AbortSignal, true);
});

test("baseline 조회는 기준 시각 이하 마지막 commit 한 건만 요청한다", async () => {
  const requests: URL[] = [];
  const source = new GitHubPricingHistorySource(async (input) => {
    requests.push(new URL(String(input)));
    return jsonResponse([]);
  });

  assert.deepEqual(await source.listBaseline(new Date("2026-07-07T00:00:00Z")), []);
  assert.equal(requests[0]?.searchParams.has("since"), false);
  assert.equal(requests[0]?.searchParams.get("until"), "2026-07-07T00:00:00.000Z");
  assert.equal(requests[0]?.searchParams.get("per_page"), "1");
  assert.equal(requests[0]?.searchParams.get("page"), "1");
});

test("429는 retry-after를 durable reset 시각으로 변환한다", async () => {
  const source = new GitHubPricingHistorySource(
    async () => new Response("limited", {
      status: 429,
      headers: { "retry-after": "120" },
    }),
    () => new Date("2026-07-14T00:00:00Z"),
  );

  await assert.rejects(
    source.listBaseline(new Date("2026-07-07T00:00:00Z")),
    (error) => error instanceof PricingSourceRateLimitError &&
      error.resetAt.toISOString() === "2026-07-14T00:02:00.000Z",
  );
});

test("남은 REST quota가 0이면 reset header 전까지 대기한다", async () => {
  const resetSeconds = Date.parse("2026-07-14T00:05:00Z") / 1_000;
  const source = new GitHubPricingHistorySource(async () => jsonResponse([], {
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSeconds),
    },
  }));

  await assert.rejects(
    source.listBaseline(new Date("2026-07-07T00:00:00Z")),
    (error) => error instanceof PricingSourceRateLimitError &&
      error.resetAt.toISOString() === "2026-07-14T00:05:00.000Z",
  );
});

test("commit snapshot은 SHA를 검증하고 LiteLLM 가격 단위로 파싱한다", async () => {
  const requests: URL[] = [];
  const source = new GitHubPricingHistorySource(async (input) => {
    requests.push(new URL(String(input)));
    return jsonResponse({
      "claude-opus-4-8": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
      },
    });
  });

  await assert.rejects(source.fetchSnapshot("../main"), /invalid pricing source sha/);
  const pricing = await source.fetchSnapshot("b".repeat(40));
  assert.deepEqual(pricing.get("claude-opus-4-8"), {
    inputPerM: 5,
    outputPerM: 25,
    cacheReadPerM: 0.5,
    cacheCreatePerM: 6.25,
  });
  assert.equal(
    requests[0]?.href,
    `https://raw.githubusercontent.com/BerriAI/litellm/${"b".repeat(40)}/model_prices_and_context_window.json`,
  );
});

test("문법이 깨진 immutable snapshot은 재시도 가능한 네트워크 오류와 구분한다", async () => {
  const source = new GitHubPricingHistorySource(async () => new Response('{"model-a": {', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  await assert.rejects(
    source.fetchSnapshot("c".repeat(40)),
    (error) => error instanceof Error && error.name === "PricingSnapshotInvalidError",
  );
});

test("잘못된 commit 응답은 source 데이터 오류로 거부한다", async () => {
  const source = new GitHubPricingHistorySource(async () => jsonResponse([{
    sha: "not-a-sha",
    commit: { committer: { date: "not-a-date" } },
  }]));

  await assert.rejects(
    source.listChanges(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-08T00:00:00Z"),
      1,
    ),
    /invalid pricing commit response/,
  );
});
