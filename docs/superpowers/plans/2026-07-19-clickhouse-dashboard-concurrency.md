# ClickHouse Dashboard Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조직 전체 현황의 정상 수치와 정렬을 그대로 유지하면서 ClickHouse 핵심 read를 최대 두 개로 줄이고, 앱의 전체 ClickHouse 동시 작업을 네 개로 제한해 간헐적인 Server Components 실패를 제거한다.

**Architecture:** `StorageBackend`에 조직 dashboard snapshot 계약을 추가하고 ClickHouse는 현재/이전 source를 묶은 두 개의 tagged aggregate query로 구현한다. 모든 ClickHouse query, command, insert, readiness ping은 프로세스 공유 FIFO operation controller를 통과하며, 웹 계층은 핵심 snapshot 실패만 전체 error boundary로 보내고 도구 활동과 활용 지수 실패는 section 단위로 격리한다.

**Tech Stack:** TypeScript, Node.js test runner, Next.js 15 Server Components, PostgreSQL, ClickHouse JSONEachRow, `@clickhouse/client` 1.7, pnpm 9.15.0

## Global Constraints

- 정상 조회의 overview, previous overview, daily series, user/team leaderboard, provider breakdown 수치·비용 coverage·정렬을 변경하지 않는다.
- cold-cache 관리자 `/org`의 핵심 ClickHouse read는 최대 두 개다.
- 한 앱 프로세스의 ClickHouse query, command, insert, readiness ping 동시 실행은 최대 네 개다.
- ClickHouse 서버의 `max_concurrent_queries_for_user=6`은 변경하지 않는다.
- operation queue는 FIFO이며 5초 admission timeout을 사용한다.
- ClickHouse Code 202 또는 `TOO_MANY_SIMULTANEOUS_QUERIES`는 짧은 jitter 뒤 한 번만 재시도한다.
- 도구 활동과 AI 활용 지수 실패는 해당 section만 unavailable로 표시한다.
- SQL, query parameter, 사용자/팀 식별자, credential을 오류 로그에 기록하지 않는다.
- DB schema와 저장 데이터 migration을 추가하지 않는다.
- `corepack pnpm`을 사용한다.

---

## File Map

- Modify `packages/core/src/storage.ts`: 조직 dashboard query/result 타입과 최종 `StorageBackend` 메서드 계약.
- Modify `packages/storage-postgres/src/storage.ts`: 기존 개별 read를 조합하는 PostgreSQL adapter.
- Modify `packages/storage-postgres/src/storage.test.ts`: adapter의 입력 전달과 결과 동등성 테스트.
- Create `packages/storage-clickhouse/src/operation-controller.ts`: FIFO admission, timeout, overload/network retry, 안전한 최종 로그.
- Create `packages/storage-clickhouse/src/operation-controller.test.ts`: 동시성, FIFO, timeout, 취소, retry, 로그 테스트.
- Modify `packages/storage-clickhouse/src/storage.ts`: 모든 ClickHouse 작업을 controller에 연결하고 두-query dashboard snapshot 구현.
- Modify `packages/storage-clickhouse/src/storage.test.ts`: operation 우회 방지, query count, bundle parsing, source/coverage/정렬 회귀 테스트.
- Create `packages/storage-clickhouse/src/dashboard.integration.test.ts`: 실제 ClickHouse에서 기존 개별 결과와 snapshot 결과 parity 및 SQL 실행 검증.
- Create `apps/web/lib/org-dashboard-data.ts`: 핵심/선택 데이터 로딩과 실패 등급화.
- Create `apps/web/lib/org-dashboard-data.test.ts`: 핵심 실패 전파, 선택 실패 격리, 안전 로그 테스트.
- Modify `apps/web/app/(dashboard)/org/page.tsx`: snapshot 사용과 section unavailable UI.
- Modify `apps/web/messages/ko/org.json`: section unavailable 한국어 문구.
- Modify `apps/web/messages/en/org.json`: section unavailable 영어 문구.
- Modify `apps/web/lib/dashboard-ready.test.ts`: 성공 marker와 부분 실패 분기 위치 회귀 검증.

---

### Task 1: Define the dashboard snapshot and PostgreSQL adapter

**Files:**
- Modify: `packages/core/src/storage.ts:1-15, 220-245`
- Modify: `packages/storage-postgres/src/storage.ts:1-35, 930-1040`
- Modify: `packages/storage-postgres/src/storage.test.ts`

**Interfaces:**
- Produces: `OrganizationDashboardQuery`
- Produces: `OrganizationDashboardData`
- Produces: `PostgresStorage.getOrganizationDashboard(q): Promise<OrganizationDashboardData>`
- Defers: `StorageBackend.getOrganizationDashboard` is added in Task 4 when both backend implementations exist.

- [ ] **Step 1: Write the failing PostgreSQL adapter test**

`packages/storage-postgres/src/storage.test.ts`에 기존 메서드를 deterministic stub으로 바꾸고 전달 인수와 반환 조합을 검증한다.

```ts
test("Postgres 조직 dashboard adapter는 기존 집계를 같은 입력으로 조합한다", async () => {
  const storage = new PostgresStorage({} as Pool);
  const current = {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
    providerKey: "codex",
    bucket: "day" as const,
    timezone: "Asia/Seoul",
  };
  const previous = {
    from: new Date("2026-06-24T00:00:00.000Z"),
    to: new Date("2026-07-01T00:00:00.000Z"),
    providerKey: "codex",
  };
  const overview = {
    totalSessions: 2, activeUsers: 1, totalCostUsd: 1,
    totalInputTokens: 10, totalOutputTokens: 5,
    totalCacheReadTokens: 2, totalCacheCreationTokens: 1,
    costCoverage: { pricedEvents: 2, unpricedEvents: 0, legacyEvents: 0 },
  };
  const previousOverview = { ...overview, totalSessions: 1, totalCostUsd: 0.5 };
  const daily = [{
    day: "2026-07-01", sessions: 2, activeUsers: 1, costUsd: 1,
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1,
  }];
  const topUsers = [{
    key: "user-1", label: "User 1", costUsd: 1, totalTokens: 18, sessions: 2,
    costCoverage: overview.costCoverage,
  }];
  const topTeams = [{
    key: "team-1", label: "Team 1", costUsd: 1, totalTokens: 18, sessions: 2,
    costCoverage: overview.costCoverage,
  }];
  const providerBreakdown = [{
    providerKey: "codex", costUsd: 1, totalTokens: 18, sessions: 2,
    costCoverage: overview.costCoverage,
  }];
  const calls: Array<[string, unknown]> = [];

  storage.getOverview = async (q) => {
    calls.push(["overview", q]);
    return q.from === current.from ? overview : previousOverview;
  };
  storage.getDailyTimeseries = async (q) => { calls.push(["daily", q]); return daily; };
  storage.getLeaderboard = async (q) => {
    calls.push([`leader:${q.scope}`, q]);
    return q.scope === "user" ? topUsers : topTeams;
  };
  storage.getProviderBreakdown = async (q) => { calls.push(["provider", q]); return providerBreakdown; };

  const result = await storage.getOrganizationDashboard({
    current, previous, includeTeamLeaderboard: true, leaderboardOrder: "tokens",
  });

  assert.deepEqual(result, { overview, previousOverview, daily, topUsers, topTeams, providerBreakdown });
  assert.deepEqual(calls.map(([name]) => name), [
    "overview", "overview", "daily", "leader:user", "leader:team", "provider",
  ]);
  assert.equal((calls[3]![1] as { orderBy: string }).orderBy, "tokens");
});
```

팀 순위를 숨기는 별도 test는 `includeTeamLeaderboard:false`에서 `leader:team` 호출이 없고 `topTeams`가 빈 배열인지 확인한다.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
corepack pnpm --filter @toard/storage-postgres test
```

Expected: FAIL with `Property 'getOrganizationDashboard' does not exist`.

- [ ] **Step 3: Add the core types and PostgreSQL implementation**

`packages/core/src/storage.ts`에 다음 타입을 추가한다.

```ts
export interface OrganizationDashboardQuery {
  current: PeriodQuery & BucketOptions;
  previous: PeriodQuery;
  includeTeamLeaderboard: boolean;
  leaderboardOrder: LeaderOrder;
}

export interface OrganizationDashboardData {
  overview: OverviewStats;
  previousOverview: OverviewStats;
  daily: DailyPoint[];
  topUsers: LeaderRow[];
  topTeams: LeaderRow[];
  providerBreakdown: ProviderBreakdown[];
}
```

`packages/storage-postgres/src/storage.ts`에서 두 타입을 import하고 다음 메서드를 추가한다.

```ts
async getOrganizationDashboard(q: OrganizationDashboardQuery): Promise<OrganizationDashboardData> {
  const [overview, previousOverview, daily, topUsers, topTeams, providerBreakdown] = await Promise.all([
    this.getOverview(q.current),
    this.getOverview(q.previous),
    this.getDailyTimeseries(q.current),
    this.getLeaderboard({ ...q.current, scope: "user", orderBy: q.leaderboardOrder }),
    q.includeTeamLeaderboard
      ? this.getLeaderboard({ ...q.current, scope: "team" })
      : Promise.resolve([]),
    this.getProviderBreakdown(q.current),
  ]);
  return { overview, previousOverview, daily, topUsers, topTeams, providerBreakdown };
}
```

- [ ] **Step 4: Run tests and typechecks**

```bash
corepack pnpm --filter @toard/core typecheck
corepack pnpm --filter @toard/storage-postgres test
corepack pnpm --filter @toard/storage-postgres typecheck
```

Expected: all commands exit 0; the two new adapter tests pass.

- [ ] **Step 5: Commit the contract adapter**

```bash
git add packages/core/src/storage.ts packages/storage-postgres/src/storage.ts packages/storage-postgres/src/storage.test.ts
git commit -m "feat(storage): add organization dashboard snapshot types"
```

---

### Task 2: Build the process-wide ClickHouse operation controller

**Files:**
- Create: `packages/storage-clickhouse/src/operation-controller.ts`
- Create: `packages/storage-clickhouse/src/operation-controller.test.ts`

**Interfaces:**
- Produces: `ClickHouseOperationRunner.run(operation, action, options?)`
- Produces: `ClickHouseOperationController`
- Produces: `ClickHouseAdmissionTimeoutError`
- Produces: `ClickHouseOverloadError`
- Produces: `defaultClickHouseOperationController`

- [ ] **Step 1: Write failing controller tests**

다음 계약을 각각 `node:test` case로 작성한다.

```ts
test("operation controller는 최대 4개만 실행하고 대기자를 FIFO로 시작한다", async () => {
  const controller = new ClickHouseOperationController({ maxConcurrent: 4, queueTimeoutMs: 1_000 });
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  const jobs = Array.from({ length: 6 }, (_, index) => controller.run(`job-${index}`, async () => {
    started.push(index);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.set(index, resolve));
    active -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases.get(0)!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases.get(1)!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const index of [2, 3, 4, 5]) releases.get(index)!();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 4);
});

test("queue timeout과 abort는 항목을 제거하고 다음 작업을 막지 않는다", async () => {
  const controller = new ClickHouseOperationController({ maxConcurrent: 1, queueTimeoutMs: 10 });
  let release!: () => void;
  const first = controller.run("first", () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(controller.run("timeout", async () => undefined), ClickHouseAdmissionTimeoutError);
  const abort = new AbortController();
  const cancelled = controller.run("cancelled", async () => undefined, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, /aborted/i);
  release();
  await first;
  assert.equal(await controller.run("next", async () => 7), 7);
});

test("Code 202는 한 번만 재시도하고 안전한 overload 오류를 남긴다", async () => {
  const records: unknown[] = [];
  let attempts = 0;
  const controller = new ClickHouseOperationController({
    sleep: async () => undefined,
    random: () => 0,
    log: (record) => records.push(record),
  });
  await assert.rejects(
    controller.run("organization_dashboard_usage", async () => {
      attempts += 1;
      throw Object.assign(new Error("SELECT secret FROM usage_events WHERE user_id='private'"), { code: 202 });
    }, { retryTransient: true }),
    ClickHouseOverloadError,
  );
  assert.equal(attempts, 2);
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(records), /SELECT|private|usage_events/);
});
```

기존 정책 보존을 위해 `retryTransient:true`인 `ECONNRESET`은 최대 5 attempts, 일반 syntax 오류는 재시도 0회이며 `retryTransient`를 생략한 insert action은 `ECONNRESET`이어도 한 번만 실행되는 test도 추가한다.

- [ ] **Step 2: Run tests and verify RED**

```bash
corepack pnpm --filter @toard/storage-clickhouse exec node --import tsx --test src/operation-controller.test.ts
```

Expected: FAIL because `operation-controller.ts` does not exist.

- [ ] **Step 3: Implement the controller**

구현은 다음 공개 surface와 상태 전이를 그대로 사용한다.

```ts
export type ClickHouseOperationLog = {
  event: "clickhouse_operation_failed";
  backend: "clickhouse";
  operation: string;
  errorClass: "network" | "overload" | "admission_timeout" | "query";
  errorCode?: string;
  attempt: number;
  durationMs: number;
  queueWaitMs: number;
  inFlight: number;
};

export interface ClickHouseOperationRunner {
  run<T>(
    operation: string,
    action: () => Promise<T>,
    options?: { signal?: AbortSignal; retryTransient?: boolean },
  ): Promise<T>;
}

export class ClickHouseAdmissionTimeoutError extends Error {
  constructor(
    readonly queueWaitMs: number,
    readonly inFlight: number,
  ) {
    super("ClickHouse operation admission timed out");
    this.name = "ClickHouseAdmissionTimeoutError";
  }
}

export class ClickHouseOverloadError extends Error {
  readonly code = "202";
  constructor(readonly operation: string, options: { cause: unknown }) {
    super("ClickHouse is temporarily overloaded", options);
    this.name = "ClickHouseOverloadError";
  }
}
```

내부 gate는 `active`, FIFO `queue`, 각 항목의 timeout handle과 optional abort listener를 가진다. slot 획득 시 `{ queueWaitMs, inFlight }`를 반환하고 `finally`에서 release한다. `retryTransient:true`인 JSON read와 readiness ping만 network attempts 5회와 overload attempts 2회를 사용한다. command/insert의 기본값은 재시도 없이 한 번 실행이다. sleep 전에 slot이 반환된 상태여야 한다. overload jitter는 `100 + Math.floor(random() * 200)`ms, network backoff는 `150 * 2 ** retryIndex`ms다.

최종 실패에서만 다음 형식으로 logger를 한 번 호출한다.

```ts
this.log({
  event: "clickhouse_operation_failed",
  backend: "clickhouse",
  operation,
  errorClass: classify(error),
  ...(errorCode(error) ? { errorCode: errorCode(error) } : {}),
  attempt,
  durationMs: Date.now() - startedAt,
  queueWaitMs: lastLease.queueWaitMs,
  inFlight: lastLease.inFlight,
});
```

기본 logger는 `console.warn(JSON.stringify(record))`이고 오류 message, stack, SQL, parameter는 record에 넣지 않는다. module 하단에 기본값 4/5000을 쓰는 `defaultClickHouseOperationController`를 한 개만 생성한다.

- [ ] **Step 4: Run controller tests and typecheck**

```bash
corepack pnpm --filter @toard/storage-clickhouse exec node --import tsx --test src/operation-controller.test.ts
corepack pnpm --filter @toard/storage-clickhouse typecheck
```

Expected: controller tests pass; typecheck exits 0.

- [ ] **Step 5: Commit the controller**

```bash
git add packages/storage-clickhouse/src/operation-controller.ts packages/storage-clickhouse/src/operation-controller.test.ts
git commit -m "feat(clickhouse): add bounded operation controller"
```

---

### Task 3: Route every ClickHouse operation through the controller

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts:1-170, 540-640, 1280-1335, 1450-2310, 2930-2995`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: `ClickHouseOperationRunner`
- Produces: `ClickHouseStorageOptions.operationRunner?: ClickHouseOperationRunner`
- Produces: `queryJson(..., operation?: string)` with gate/retry applied per attempt.

- [ ] **Step 1: Write failing storage admission tests**

`packages/storage-clickhouse/src/storage.test.ts`에 동시 read가 네 개를 넘지 않는 test를 추가한다. fixture의 `query`는 schema command 뒤 각 JSON read를 promise로 보류하고 active count를 기록한다.

```ts
test("ClickHouseStorage의 동시 JSON read는 네 개를 넘지 않는다", async () => {
  let active = 0;
  let maxActive = 0;
  const releases = new Map<number, () => void>();
  let nextIndex = 0;
  const ch = {
    command: async () => undefined,
    query: async () => {
      const index = nextIndex++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(index, resolve));
      active -= 1;
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
  const runner = new ClickHouseOperationController({ maxConcurrent: 4, queueTimeoutMs: 1_000 });
  const storage = new ClickHouseStorage(ch, {} as Pool, { operationRunner: runner });
  const jobs = Array.from({ length: 6 }, (_, index) => storage.getUserHosts(`user-${index}`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  releases.get(0)!();
  await new Promise((resolve) => setImmediate(resolve));
  releases.get(1)!();
  await new Promise((resolve) => setImmediate(resolve));
  for (const index of [2, 3, 4, 5]) releases.get(index)!();
  await Promise.all(jobs);
  assert.equal(maxActive, 4);
});
```

별도 source guard test는 `storage.ts`의 `this.ch.query|command|insert` 각 호출이 `operationRunner.run` callback 내부에만 존재하고, `pingClickHouse`가 `defaultClickHouseOperationController.run("readiness_ping", ...)`을 사용하는지 확인한다.

- [ ] **Step 2: Run tests and verify RED**

```bash
corepack pnpm --filter @toard/storage-clickhouse test
```

Expected: new admission test observes 6 active reads or `operationRunner` option type is missing.

- [ ] **Step 3: Wire storage operations**

`ClickHouseStorageOptions`와 constructor에 runner를 연결한다.

```ts
export interface ClickHouseStorageOptions {
  timezone?: string;
  readFinal?: boolean;
  readRollup?: RollupReadMode;
  read15mRollup?: boolean;
  read15mV2Rollup?: RollupReadMode;
  enforceRetentionTtl?: boolean;
  operationRunner?: ClickHouseOperationRunner;
}

private readonly operationRunner: ClickHouseOperationRunner;

constructor(
  private readonly ch: ClickHouseClient,
  private readonly pg: Pool,
  opts: ClickHouseStorageOptions = {},
) {
  this.operationRunner = opts.operationRunner ?? defaultClickHouseOperationController;
  this.tz = safeTimezone(opts.timezone);
  this.usageEventsSource = opts.readFinal ? "usage_events FINAL" : "usage_events";
  this.readRollup = opts.readRollup ?? false;
  this.read15mRollup = opts.read15mRollup ?? false;
  this.read15mV2Rollup = opts.read15mV2Rollup ?? false;
  this.enforceRetentionTtl = opts.enforceRetentionTtl ?? false;
}
```

`queryJson`은 schema 준비가 끝난 뒤 slot을 얻는다. retry sleep 동안 slot을 보유하지 않도록 retry는 runner가 callback 바깥에서 수행한다.

```ts
private async queryJson<T>(
  query: string,
  query_params: Params,
  clickhouse_settings?: ClickHouseSettings,
  operation = "clickhouse_query",
): Promise<T[]> {
  await this.ensureSchema();
  return this.operationRunner.run(operation, async () => {
    const rs = await this.ch.query({
      query,
      query_params,
      clickhouse_settings,
      format: "JSONEachRow",
    });
    return rs.json<T>();
  }, { retryTransient: true });
}
```

schema DDL, `getRollupStorageStats`의 두 query, raw/outbox/rollup insert, mutation command를 모두 고정 operation name으로 감싼다. 예시는 다음과 같고 나머지 직접 호출도 같은 형태로 바꾼다.

```ts
await this.operationRunner.run("ensure_schema", () => this.ch.command({ query }));
await this.operationRunner.run("save_raw_event", () => this.ch.insert({
  table: "raw_events",
  values: [{ id, provider_key: providerKey, payload: JSON.stringify(payload) }],
  format: "JSONEachRow",
}));
```

`pingClickHouse()`는 attempt마다 client를 만들고 닫는 기존 생명주기를 runner callback 안에 유지한다.

```ts
export async function pingClickHouse(): Promise<void> {
  await defaultClickHouseOperationController.run("readiness_ping", async () => {
    const ch = createClickHouseClient();
    try {
      const result = await ch.ping({ select: true });
      if (!result.success) throw result.error;
    } finally {
      await ch.close();
    }
  }, { retryTransient: true });
}
```

기존 `retryTransientClickHouseError`, transient code set, `sleep`, 중복 error-code helper는 controller로 이동했으므로 `storage.ts`에서 제거한다.

- [ ] **Step 4: Verify all operations and regressions**

```bash
rg -n "this\.ch\.(query|command|insert)" packages/storage-clickhouse/src/storage.ts
corepack pnpm --filter @toard/storage-clickhouse test
corepack pnpm --filter @toard/storage-clickhouse typecheck
```

Expected: `rg`로 나온 모든 client 호출은 runner callback 내부다; package tests and typecheck pass.

- [ ] **Step 5: Commit operation wiring**

```bash
git add packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "fix(clickhouse): bound all client operations"
```

---

### Task 4: Implement the two-query ClickHouse dashboard snapshot

**Files:**
- Modify: `packages/core/src/storage.ts:340-370`
- Modify: `packages/storage-clickhouse/src/storage.ts:90-145, 1220-1300, 2330-2860`
- Modify: `packages/storage-clickhouse/src/storage.test.ts`

**Interfaces:**
- Consumes: `OrganizationDashboardQuery`, `OrganizationDashboardData`
- Produces: `StorageBackend.getOrganizationDashboard(q): Promise<OrganizationDashboardData>`
- Produces: `ClickHouseStorage.getOrganizationDashboard(q)` with operation names `organization_dashboard_usage` and `organization_dashboard_breakdown`.

- [ ] **Step 1: Write failing bundle tests**

fixture는 query tag에 따라 usage bundle과 breakdown bundle row를 반환하고 PostgreSQL label query에는 사용자/팀 이름을 반환한다.

```ts
test("ClickHouse 조직 dashboard는 두 query로 기존 공개 결과를 조립한다", async () => {
  const queries: string[] = [];
  const ch = {
    command: async () => undefined,
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      if (query.includes("organization-dashboard-usage")) return { json: async () => [
        { result_kind: "current_overview", day: null, sessions: "2", active_users: "1", cost: "1", input: "10", output: "5", cache_read: "2", cache_creation: "1", priced_events: "2", unpriced_events: "0", legacy_events: "0" },
        { result_kind: "previous_overview", day: null, sessions: "1", active_users: "1", cost: "0.5", input: "5", output: "2", cache_read: "0", cache_creation: "0", priced_events: "1", unpriced_events: "0", legacy_events: "0" },
        { result_kind: "daily", day: "2026-07-01", sessions: "2", active_users: "1", cost: "1", input: "10", output: "5", cache_read: "2", cache_creation: "1", priced_events: "0", unpriced_events: "0", legacy_events: "0" },
      ] };
      return { json: async () => [
        { result_kind: "user_leader", key: "user-1", cost: "1", tokens: "18", sessions: "2", priced_events: "2", unpriced_events: "0", legacy_events: "0" },
        { result_kind: "team_leader", key: "team-1", cost: "1", tokens: "18", sessions: "2", priced_events: "2", unpriced_events: "0", legacy_events: "0" },
        { result_kind: "provider", key: "codex", cost: "1", tokens: "18", sessions: "2", priced_events: "2", unpriced_events: "0", legacy_events: "0" },
      ] };
    },
  } as unknown as ClickHouseClient;
  const pg = {
    query: async (sql: string) => ({ rows: sql.includes("FROM users")
      ? [{ id: "user-1", label: "User 1" }]
      : [{ id: "team-1", label: "Team 1" }] }),
  } as unknown as Pool;
  const storage = new ClickHouseStorage(ch, pg, { readRollup: false, read15mV2Rollup: false });
  const result = await storage.getOrganizationDashboard({
    current: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-08T00:00:00Z"), bucket: "day", timezone: "UTC" },
    previous: { from: new Date("2026-06-24T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") },
    includeTeamLeaderboard: true,
    leaderboardOrder: "tokens",
  });
  assert.equal(queries.length, 2);
  assert.equal(result.overview.totalCostUsd, 1);
  assert.equal(result.previousOverview.totalCostUsd, 0.5);
  assert.equal(result.daily[0]?.day, "2026-07-01");
  assert.equal(result.topUsers[0]?.label, "User 1");
  assert.equal(result.topTeams[0]?.label, "Team 1");
  assert.equal(result.providerBreakdown[0]?.providerKey, "codex");
});
```

추가 test는 팀 branch 제외, `leaderboardOrder:"cost"|"tokens"`, unknown `result_kind` rejection, 필수 current/previous overview row 누락 rejection, current/previous parameter namespace 충돌 방지를 검증한다. 기존 `sourceRouterFixture`를 사용해 current timezone rollup + previous exact source 조합과 raw fallback 조합에서 기존 coverage 식이 그대로 포함되는지도 확인한다.

cache miss와 background read가 겹치는 회귀 test는 snapshot과 `getOrganizationUtilizationUsage()`를 동시에 시작하고 fake client가 active count 6 초과 시 Code 202를 throw하게 한다. assertion은 전체 promise 성공, snapshot query tag 두 개, 관측 active 최대 4다.

- [ ] **Step 2: Run tests and verify RED**

```bash
corepack pnpm --filter @toard/storage-clickhouse test
```

Expected: `getOrganizationDashboard` is missing and `ClickHouseStorage` no longer satisfies the final interface after Step 3 adds it.

- [ ] **Step 3: Add the interface method and source envelope**

`StorageBackend` read section에 다음 메서드를 추가한다.

```ts
getOrganizationDashboard(q: OrganizationDashboardQuery): Promise<OrganizationDashboardData>;
```

ClickHouse source는 기존 `namespaceTimeseriesSource`를 이용해 current와 previous parameter를 분리한다.

```ts
const timezone = safeTimezone(q.current.timezone, this.tz);
const [currentSourceRaw, previousSourceRaw] = await Promise.all([
  this.resolveTimeseriesSource(q.current, q.current.bucket, timezone),
  this.resolveTimeseriesSource(q.previous, undefined, this.tz),
]);
const current = this.namespaceTimeseriesSource(currentSourceRaw, "dashboard_current");
const previous = this.namespaceTimeseriesSource(previousSourceRaw, "dashboard_previous");
const columns = `ts, provider_key, user_id, team_id, session_id, model, host,
                 input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                 cost_usd, cost_status, event_count`;
const tagged = `(
  SELECT 'previous' AS period, ${columns} FROM ${previous.source}
  UNION ALL
  SELECT 'current' AS period, ${columns} FROM ${current.source}
)`;
const params = { ...previous.params, ...current.params };
```

- [ ] **Step 4: Implement the usage and breakdown bundles**

usage SQL은 고정 query tag를 두고 current overview, previous overview, current daily의 compatible superset column을 `UNION ALL`로 반환한다. overview branch는 `day`를 `Nullable(String)` null로 cast하고 daily branch는 기존 bucket 표현식을 사용한다.

```ts
const bucketExpr = this.bucketExpr(q.current.bucket, "ts", timezone);
const usageSql = `WITH '/* organization-dashboard-usage */' AS query_tag,
tagged AS ${tagged}
SELECT 'current_overview' AS result_kind, CAST(NULL AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'current'
UNION ALL
SELECT 'previous_overview' AS result_kind, CAST(NULL AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'previous'
UNION ALL
SELECT 'daily' AS result_kind, CAST(${bucketExpr} AS Nullable(String)) AS day,
       uniqExactIf(session_id, session_id != '') AS sessions,
       uniqExactIf(user_id, user_id != '') AS active_users,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens) AS input, sum(output_tokens) AS output,
       sum(cache_read_tokens) AS cache_read, sum(cache_creation_tokens) AS cache_creation,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM tagged WHERE period = 'current'
GROUP BY day ORDER BY result_kind, day`;
```

breakdown SQL은 current source만 사용하고 다음 세 branch를 같은 row envelope로 반환한다.

```ts
const teamBranch = q.includeTeamLeaderboard ? `
UNION ALL
SELECT 'team_leader' AS result_kind, key, cost, tokens, sessions,
       priced_events, unpriced_events, legacy_events
FROM (
  SELECT team_id AS key,
         sumIf(cost_usd, cost_status != 'unpriced') AS cost,
         sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
         uniqExactIf(session_id, session_id != '') AS sessions,
         sumIf(event_count, cost_status = 'priced') AS priced_events,
         sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
         sumIf(event_count, cost_status = 'legacy') AS legacy_events
  FROM ${current.source} WHERE team_id != ''
  GROUP BY key ORDER BY cost DESC LIMIT 100
)` : "";

const breakdownSql = `WITH '/* organization-dashboard-breakdown */' AS query_tag
SELECT 'user_leader' AS result_kind, key, cost, tokens, sessions,
       priced_events, unpriced_events, legacy_events
FROM (
  SELECT user_id AS key,
         sumIf(cost_usd, cost_status != 'unpriced') AS cost,
         sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
         uniqExactIf(session_id, session_id != '') AS sessions,
         sumIf(event_count, cost_status = 'priced') AS priced_events,
         sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
         sumIf(event_count, cost_status = 'legacy') AS legacy_events
  FROM ${current.source} WHERE user_id != ''
  GROUP BY key ORDER BY ${orderColumn} DESC LIMIT 100
)
${teamBranch}
UNION ALL
SELECT 'provider' AS result_kind, provider_key AS key,
       sumIf(cost_usd, cost_status != 'unpriced') AS cost,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
       uniqExactIf(session_id, session_id != '') AS sessions,
       sumIf(event_count, cost_status = 'priced') AS priced_events,
       sumIf(event_count, cost_status = 'unpriced') AS unpriced_events,
       sumIf(event_count, cost_status = 'legacy') AS legacy_events
FROM ${current.source}
GROUP BY provider_key ORDER BY tokens DESC`;
```

`orderColumn`은 허용된 enum에서만 `tokens` 또는 `cost`를 선택한다. 외부 입력을 SQL identifier로 직접 삽입하지 않는다.

두 query는 다음처럼 동시에 실행하고 operation name을 전달한다.

```ts
const [usageRows, breakdownRows] = await Promise.all([
  this.queryJson<OrganizationUsageBundleRow>(usageSql, params, undefined, "organization_dashboard_usage"),
  this.queryJson<OrganizationBreakdownBundleRow>(breakdownSql, current.params, undefined, "organization_dashboard_breakdown"),
]);
```

parser는 unknown kind와 필수 overview 누락을 throw하고, `n()`과 `costCoverage()`로 기존 공개 타입을 만든다. 핵심 분배는 다음 형태다.

```ts
const usageKinds = new Set(["current_overview", "previous_overview", "daily"]);
if (usageRows.some((row) => !usageKinds.has(row.result_kind))) {
  throw new Error("Unknown organization dashboard usage row kind");
}
const currentRow = usageRows.find((row) => row.result_kind === "current_overview");
const previousRow = usageRows.find((row) => row.result_kind === "previous_overview");
if (!currentRow || !previousRow) throw new Error("Organization dashboard overview row is missing");
if (usageRows.some((row) => row.result_kind === "daily" && row.day == null)) {
  throw new Error("Organization dashboard daily row is missing its bucket");
}

const toOverview = (row: OrganizationUsageBundleRow): OverviewStats => ({
  totalSessions: n(row.sessions), activeUsers: n(row.active_users), totalCostUsd: n(row.cost),
  totalInputTokens: n(row.input), totalOutputTokens: n(row.output),
  totalCacheReadTokens: n(row.cache_read), totalCacheCreationTokens: n(row.cache_creation),
  costCoverage: costCoverage(row),
});
const daily = usageRows.filter((row) => row.result_kind === "daily").map((row) => ({
  day: row.day!, sessions: n(row.sessions), activeUsers: n(row.active_users), costUsd: n(row.cost),
  inputTokens: n(row.input), outputTokens: n(row.output),
  cacheReadTokens: n(row.cache_read), cacheCreationTokens: n(row.cache_creation),
})).sort((a, b) => a.day.localeCompare(b.day));

const breakdownKinds = new Set(["user_leader", "team_leader", "provider"]);
if (breakdownRows.some((row) => !breakdownKinds.has(row.result_kind))) {
  throw new Error("Unknown organization dashboard breakdown row kind");
}
const userRows = breakdownRows.filter((row) => row.result_kind === "user_leader");
const teamRows = breakdownRows.filter((row) => row.result_kind === "team_leader");
const providerRows = breakdownRows.filter((row) => row.result_kind === "provider");
const [userLabels, teamLabels] = await Promise.all([
  this.labelMap("user", userRows.map((row) => row.key)),
  q.includeTeamLeaderboard
    ? this.labelMap("team", teamRows.map((row) => row.key))
    : Promise.resolve(new Map<string, string>()),
]);
```

leader/provider mapper는 `costUsd:n(cost)`, `totalTokens:n(tokens)`, `sessions:n(sessions)`, `costCoverage:costCoverage(row)`를 사용하고 label은 `labels.get(key) ?? key`로 보존한다. SQL branch의 기존 `ORDER BY` 순서를 유지한다.

- [ ] **Step 5: Run backend tests and typechecks**

```bash
corepack pnpm --filter @toard/core typecheck
corepack pnpm --filter @toard/storage-postgres test
corepack pnpm --filter @toard/storage-postgres typecheck
corepack pnpm --filter @toard/storage-clickhouse test
corepack pnpm --filter @toard/storage-clickhouse typecheck
```

Expected: all commands exit 0; ClickHouse bundle test observes exactly two JSON read queries.

- [ ] **Step 6: Commit the snapshot implementation**

```bash
git add packages/core/src/storage.ts packages/storage-clickhouse/src/storage.ts packages/storage-clickhouse/src/storage.test.ts
git commit -m "feat(clickhouse): consolidate organization dashboard reads"
```

---

### Task 5: Isolate optional web sections without changing core results

**Files:**
- Create: `apps/web/lib/org-dashboard-data.ts`
- Create: `apps/web/lib/org-dashboard-data.test.ts`
- Modify: `apps/web/app/(dashboard)/org/page.tsx:1-25, 417-445, 550-570`
- Modify: `apps/web/messages/ko/org.json`
- Modify: `apps/web/messages/en/org.json`
- Modify: `apps/web/lib/dashboard-ready.test.ts`

**Interfaces:**
- Produces: `OptionalDashboardSection<T> = { state: "available"; value: T } | { state: "unavailable" }`
- Produces: `loadOrganizationDashboardData(input, deps?)`
- Consumes: `StorageBackend.getOrganizationDashboard`

- [ ] **Step 1: Write failing loader tests**

```ts
const overview = {
  totalSessions: 0, activeUsers: 0, totalCostUsd: 0,
  totalInputTokens: 0, totalOutputTokens: 0,
  totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
  costCoverage: { pricedEvents: 0, unpricedEvents: 0, legacyEvents: 0 },
};
const dashboard: OrganizationDashboardData = {
  overview, previousOverview: overview, daily: [], topUsers: [], topTeams: [], providerBreakdown: [],
};
const input = {
  dashboard: {
    current: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-08T00:00:00Z"), bucket: "day" as const, timezone: "UTC" },
    previous: { from: new Date("2026-06-24T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") },
    includeTeamLeaderboard: true,
    leaderboardOrder: "tokens" as const,
  },
  toolPeriod: { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-08T00:00:00Z") },
};
const toolSummary: ToolActivitySummary = {
  mcpCalls: 1, distinctSkills: 1, distinctPlugins: 1, failures: 0, activeUsers: 1, activeDevices: 1,
};
const utilization: OrganizationUtilizationResult = {
  state: "suppressed",
  methodologyVersion: UTILIZATION_METHODOLOGY_VERSION,
  reason: "suppressed_small_cohort",
};

test("핵심 dashboard 실패는 그대로 전파한다", async () => {
  const coreError = new Error("core unavailable");
  await assert.rejects(loadOrganizationDashboardData(input, {
    getDashboard: async () => { throw coreError; },
    getToolActivity: async () => toolSummary,
    getUtilization: async () => utilization,
    warn: () => undefined,
  }), (error) => error === coreError);
});

test("선택 데이터 실패는 해당 section만 unavailable로 격리한다", async () => {
  const warnings: unknown[] = [];
  const result = await loadOrganizationDashboardData(input, {
    getDashboard: async () => dashboard,
    getToolActivity: async () => { throw new Error("private tool query"); },
    getUtilization: async () => utilization,
    warn: (record) => warnings.push(record),
  });
  assert.equal(result.toolActivity.state, "unavailable");
  assert.deepEqual(result.utilization, { state: "available", value: utilization });
  assert.equal(result.dashboard, dashboard);
  assert.deepEqual(warnings, [{ event: "org_dashboard_optional_section_unavailable", section: "tool_activity" }]);
  assert.doesNotMatch(JSON.stringify(warnings), /private tool query/);
});

test("활용 지수 실패도 핵심과 도구 활동을 보존한다", async () => {
  const result = await loadOrganizationDashboardData(input, {
    getDashboard: async () => dashboard,
    getToolActivity: async () => toolSummary,
    getUtilization: async () => { throw new Error("private utilization query"); },
    warn: () => undefined,
  });
  assert.equal(result.dashboard, dashboard);
  assert.deepEqual(result.toolActivity, { state: "available", value: toolSummary });
  assert.deepEqual(result.utilization, { state: "unavailable" });
});

test("두 선택 section이 모두 실패해도 핵심 dashboard는 성공한다", async () => {
  const result = await loadOrganizationDashboardData(input, {
    getDashboard: async () => dashboard,
    getToolActivity: async () => { throw new Error("tool unavailable"); },
    getUtilization: async () => { throw new Error("utilization unavailable"); },
    warn: () => undefined,
  });
  assert.equal(result.dashboard, dashboard);
  assert.deepEqual(result.toolActivity, { state: "unavailable" });
  assert.deepEqual(result.utilization, { state: "unavailable" });
});
```

- [ ] **Step 2: Run loader tests and verify RED**

```bash
corepack pnpm --filter @toard/web exec node --import tsx --test lib/org-dashboard-data.test.ts
```

Expected: FAIL because `org-dashboard-data.ts` does not exist.

- [ ] **Step 3: Implement the loader**

```ts
export type OptionalDashboardSection<T> =
  | { state: "available"; value: T }
  | { state: "unavailable" };

export type OrganizationDashboardWarning = {
  event: "org_dashboard_optional_section_unavailable";
  section: "tool_activity" | "utilization";
};

export interface OrganizationDashboardDependencies {
  getDashboard(query: OrganizationDashboardQuery): Promise<OrganizationDashboardData>;
  getToolActivity(query: PeriodQuery): Promise<ToolActivitySummary>;
  getUtilization(): Promise<OrganizationUtilizationResult>;
  warn(record: OrganizationDashboardWarning): void;
}

const defaultDependencies: OrganizationDashboardDependencies = {
  getDashboard: (query) => getStorage().getOrganizationDashboard(query),
  getToolActivity: (query) => getOrgToolSummary(query),
  getUtilization: () => getCachedOrganizationUtilization(),
  warn: (record) => console.warn(JSON.stringify(record)),
};

export async function loadOrganizationDashboardData(
  input: { dashboard: OrganizationDashboardQuery; toolPeriod: PeriodQuery },
  deps: OrganizationDashboardDependencies = defaultDependencies,
) {
  const [dashboard, toolActivity, utilization] = await Promise.allSettled([
    deps.getDashboard(input.dashboard),
    deps.getToolActivity(input.toolPeriod),
    deps.getUtilization(),
  ]);
  if (dashboard.status === "rejected") throw dashboard.reason;

  const optional = <T>(
    section: "tool_activity" | "utilization",
    result: PromiseSettledResult<T>,
  ): OptionalDashboardSection<T> => {
    if (result.status === "fulfilled") return { state: "available", value: result.value };
    deps.warn({ event: "org_dashboard_optional_section_unavailable", section });
    return { state: "unavailable" };
  };

  return {
    dashboard: dashboard.value,
    toolActivity: optional("tool_activity", toolActivity),
    utilization: optional("utilization", utilization),
  };
}
```

- [ ] **Step 4: Switch `/org` and add section fallbacks**

`OverviewTab`의 기존 여덟 개 `Promise.all`을 다음 호출로 교체한다.

```ts
const { dashboard, toolActivity, utilization } = await loadOrganizationDashboardData({
  dashboard: {
    current: period,
    previous: previousPeriod(period),
    includeTeamLeaderboard: canSeeTeamRanking,
    leaderboardOrder: ORG_LEADERBOARD_METRIC,
  },
  toolPeriod: period,
});
const { overview, previousOverview: prevOverview, daily, topUsers, topTeams, providerBreakdown } = dashboard;
```

도구 활동과 활용 지수는 `state === "available"`일 때만 기존 component를 렌더링한다. unavailable branch는 기존 `Card` 구조 안에서 다음 번역을 표시한다.

```json
"sectionUnavailable": {
  "title": "일시적으로 불러오지 못했습니다",
  "description": "다른 현황은 계속 사용할 수 있습니다. 잠시 후 다시 시도해 주세요."
}
```

영어는 각각 `Temporarily unavailable`, `Other dashboard data remains available. Please try again shortly.`를 사용한다. fallback은 0값을 표시하지 않는다.

page 내부에 공통 fallback을 추가하고 두 section을 명시적으로 분기한다.

```tsx
function UnavailableSectionCard({
  sectionTitle,
  statusTitle,
  message,
}: {
  sectionTitle: string;
  statusTitle: string;
  message: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{sectionTitle}</CardTitle>
        <CardDescription>{statusTitle}</CardDescription>
      </CardHeader>
      <CardContent><p className="text-muted-foreground text-sm">{message}</p></CardContent>
    </Card>
  );
}

{toolActivity.state === "available" ? (
  <Card>
    <CardHeader><CardTitle>{t("toolActivity.title")}</CardTitle><CardDescription>{t("toolActivity.description")}</CardDescription></CardHeader>
    <CardContent className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryTile label={t("toolActivity.mcp")} value={fmtNum(toolActivity.value.mcpCalls)} icon={<Wrench className="size-3.5" />} />
      <SummaryTile label={t("toolActivity.skills")} value={fmtNum(toolActivity.value.distinctSkills)} icon={<Blocks className="size-3.5" />} />
      <SummaryTile label={t("toolActivity.plugins")} value={fmtNum(toolActivity.value.distinctPlugins)} icon={<Puzzle className="size-3.5" />} />
      <SummaryTile label={t("toolActivity.users")} value={fmtNum(toolActivity.value.activeUsers ?? 0)} icon={<Users className="size-3.5" />} />
      <SummaryTile label={t("toolActivity.devices")} value={fmtNum(toolActivity.value.activeDevices ?? 0)} />
    </CardContent>
  </Card>
) : (
  <UnavailableSectionCard
    sectionTitle={t("toolActivity.title")}
    statusTitle={t("sectionUnavailable.title")}
    message={t("sectionUnavailable.description")}
  />
)}

{utilization.state === "available" ? (
  <OrgUtilizationCard result={utilization.value} />
) : (
  <UnavailableSectionCard
    sectionTitle={t("utilization.title")}
    statusTitle={t("sectionUnavailable.title")}
    message={t("sectionUnavailable.description")}
  />
)}
```

`dashboard-ready.test.ts`에는 `/org` source가 `loadOrganizationDashboardData`를 사용하고, `data-dashboard-ready="org-overview"` marker가 핵심 snapshot 성공 이후에 있으며 optional `unavailable` branch보다 제거되지 않는지 검증하는 assertion을 추가한다.

- [ ] **Step 5: Run web tests and build checks**

```bash
corepack pnpm --filter @toard/web test
corepack pnpm --filter @toard/web typecheck
corepack pnpm --filter @toard/web build
```

Expected: all commands exit 0; loader tests show core rejection and optional isolation separately.

- [ ] **Step 6: Commit the web isolation**

```bash
git add apps/web/lib/org-dashboard-data.ts apps/web/lib/org-dashboard-data.test.ts 'apps/web/app/(dashboard)/org/page.tsx' apps/web/messages/ko/org.json apps/web/messages/en/org.json apps/web/lib/dashboard-ready.test.ts
git commit -m "fix(web): isolate optional organization dashboard failures"
```

---

### Task 6: Prove real ClickHouse parity and complete regression verification

**Files:**
- Create: `packages/storage-clickhouse/src/dashboard.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-19-clickhouse-dashboard-concurrency-design.md` only if measured behavior requires a factual correction.

**Interfaces:**
- Consumes: legacy individual read methods and `getOrganizationDashboard`.
- Produces: opt-in `RUN_CLICKHOUSE_DASHBOARD_INTEGRATION=1` parity test.

- [ ] **Step 1: Write the opt-in real ClickHouse integration test**

test는 `CLICKHOUSE_URL`의 로컬 ClickHouse에 UUID 기반 임시 database를 만들고 `finally`에서 그 database만 제거한다. production URL을 기본값으로 사용하지 않으며 환경변수가 없으면 skip한다.

```ts
const previous = {
  from: new Date("2026-06-24T00:00:00.000Z"),
  to: new Date("2026-07-01T00:00:00.000Z"),
};
const current = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-08T00:00:00.000Z"),
  bucket: "day" as const,
  timezone: "UTC",
};
const from = previous.from;
const to = current.to;
const usageRows = [
  { dedup_key: "previous-priced", provider_key: "codex", user_id: "user-1", team_id: "team-1", session_id: "session-previous", model: "gpt", ts: "2026-06-30 12:00:00.000", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: "0.50000000", pricing_revision_id: "revision-1", cost_status: "priced", log_adapter: "codex", host: "macbook" },
  { dedup_key: "current-priced", provider_key: "codex", user_id: "user-1", team_id: "team-1", session_id: "session-current-1", model: "gpt", ts: "2026-07-02 12:00:00.000", input_tokens: 20, output_tokens: 10, cache_read_tokens: 5, cache_creation_tokens: 0, cost_usd: "1.00000000", pricing_revision_id: "revision-1", cost_status: "priced", log_adapter: "codex", host: "macbook" },
  { dedup_key: "current-unpriced", provider_key: "anthropic", user_id: "user-2", team_id: "team-2", session_id: "session-current-2", model: "claude", ts: "2026-07-03 12:00:00.000", input_tokens: 40, output_tokens: 20, cache_read_tokens: 10, cache_creation_tokens: 5, cost_usd: "0.00000000", pricing_revision_id: "", cost_status: "unpriced", log_adapter: "claude", host: "macmini" },
  { dedup_key: "current-legacy", provider_key: "anthropic", user_id: "user-2", team_id: "team-2", session_id: "session-current-3", model: "claude", ts: "2026-07-04 12:00:00.000", input_tokens: 30, output_tokens: 15, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: "2.00000000", pricing_revision_id: "", cost_status: "legacy", log_adapter: "claude", host: "macmini" },
];

const labelPool = () => ({
  query: async (sql: string) => {
    if (sql.includes("FROM users")) return { rows: [
      { id: "user-1", label: "User 1" }, { id: "user-2", label: "User 2" },
    ] };
    if (sql.includes("FROM teams")) return { rows: [
      { id: "team-1", label: "Team 1" }, { id: "team-2", label: "Team 2" },
    ] };
    return { rows: [] };
  },
}) as unknown as Pool;

test("실제 ClickHouse에서 dashboard snapshot은 기존 개별 결과와 동일하다", {
  skip: process.env.RUN_CLICKHOUSE_DASHBOARD_INTEGRATION !== "1",
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.CLICKHOUSE_URL, "explicit local CLICKHOUSE_URL is required");
  const database = `toard_dashboard_${randomUUID().replaceAll("-", "")}`;
  const connection = {
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER ?? "toard",
    password: process.env.CLICKHOUSE_PASSWORD ?? "toard",
  };
  const admin = createClient(connection);
  await admin.command({ query: `CREATE DATABASE ${database}` });
  const client = createClient({ ...connection, database });
  try {
    await client.command({ query: `CREATE TABLE usage_events (
      dedup_key String, provider_key LowCardinality(String), user_id String, team_id String,
      session_id String, model LowCardinality(String), ts DateTime64(3, 'UTC'),
      input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64,
      cache_creation_tokens UInt64, cost_usd Decimal(18, 8), pricing_revision_id String DEFAULT '',
      cost_status LowCardinality(String) DEFAULT 'legacy', log_adapter LowCardinality(String) DEFAULT '',
      host LowCardinality(String) DEFAULT '', inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(inserted_at) PARTITION BY toYYYYMM(ts) ORDER BY dedup_key` });
    await client.command({ query: `CREATE TABLE raw_events (
      id UInt64, provider_key LowCardinality(String), payload String,
      received_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = MergeTree ORDER BY (received_at, id)` });
    const pg = labelPool();
    const storage = new ClickHouseStorage(client, pg, {
      timezone: "UTC", readFinal: true, readRollup: false, read15mV2Rollup: false,
    });
    await storage.getOverview({ from, to });
    await client.insert({ table: "usage_events", values: usageRows, format: "JSONEachRow" });

    const [overview, previousOverview, daily, topUsers, topTeams, providerBreakdown] = await Promise.all([
      storage.getOverview(current), storage.getOverview(previous), storage.getDailyTimeseries(current),
      storage.getLeaderboard({ ...current, scope: "user", orderBy: "tokens" }),
      storage.getLeaderboard({ ...current, scope: "team" }), storage.getProviderBreakdown(current),
    ]);
    const snapshot = await storage.getOrganizationDashboard({
      current, previous, includeTeamLeaderboard: true, leaderboardOrder: "tokens",
    });
    assert.deepEqual(snapshot, { overview, previousOverview, daily, topUsers, topTeams, providerBreakdown });
  } finally {
    await client.close();
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
  }
});
```

데이터에는 priced, unpriced, legacy, 두 사용자, 두 팀, 두 provider를 포함해 coverage와 정렬까지 비교한다. database identifier는 UUID에서 생성된 영숫자만 사용한다.

- [ ] **Step 2: Run the real integration verification**

로컬 개발용 ClickHouse를 명시적으로 띄운 뒤 실행한다.

```bash
RUN_CLICKHOUSE_DASHBOARD_INTEGRATION=1 CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=toard CLICKHOUSE_PASSWORD=toard corepack pnpm --filter @toard/storage-clickhouse exec node --import tsx --test src/dashboard.integration.test.ts
```

Expected: PASS. 실패하면 assertion이 실제 SQL syntax 또는 기존 메서드와 다른 필드를 정확히 보여 주며 production endpoint는 사용하지 않는다.

- [ ] **Step 3: Correct only measured parity differences**

통합 test가 실패하면 기존 개별 메서드를 기준으로 다음 항목만 수정한다.

```text
source selection: current bucket/timezone source and previous exact source
overview: sessions, activeUsers, confirmed cost, four token sums, three coverage counts
daily: day ordering and existing bucket label
leaderboard: selected metric descending, LIMIT 100, existing tie behavior
provider: tokens descending
labels: PostgreSQL labelMap fallback to raw key
```

새 snapshot 값을 기준으로 legacy 메서드 기대값을 바꾸지 않는다. SQL 또는 parser 수정 후 Step 2를 다시 실행해 deep equality를 통과시킨다.

- [ ] **Step 4: Run the complete verification matrix**

```bash
corepack pnpm --filter @toard/core typecheck
corepack pnpm --filter @toard/storage-postgres test
corepack pnpm --filter @toard/storage-postgres typecheck
corepack pnpm --filter @toard/storage-clickhouse test
corepack pnpm --filter @toard/storage-clickhouse typecheck
corepack pnpm --filter @toard/web test
corepack pnpm --filter @toard/web typecheck
corepack pnpm --filter @toard/web build
git diff --check
```

Expected: every command exits 0. Test output confirms bundle query count 2, operation maximum 4, optional section isolation, and real ClickHouse parity.

- [ ] **Step 5: Inspect the final change boundary**

```bash
git status --short
git diff --stat HEAD~5..HEAD
git diff -- clickhouse/users.d/toard-limits.xml migrations
```

Expected: no change under `clickhouse/users.d/toard-limits.xml` or `migrations`; only the File Map scope is modified.

- [ ] **Step 6: Commit integration evidence**

```bash
git add packages/storage-clickhouse/src/dashboard.integration.test.ts docs/superpowers/specs/2026-07-19-clickhouse-dashboard-concurrency-design.md
git commit -m "test(clickhouse): verify dashboard snapshot parity"
```

배포는 이 구현 계획의 자동 실행 범위가 아니다. merge 후 회사 환경 배포 승인을 받은 다음 설계 문서의 `/api/health`, `/api/ready`, cold/warm `/org`, Code 202 log, background flush/rollup 운영 검증을 별도로 수행한다.
