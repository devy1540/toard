# ClickHouse Hot/Cold Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a lightweight Druid-style hot/cold path in toard: recent mutable data is read from raw ClickHouse events, finalized older buckets are read from a 15-minute rollup.

**Architecture:** Keep `usage_events` as the source of truth. Add a finalized `usage_15m_rollup` table built by an idempotent compactor with a safety delay and dirty-bucket repair, then query `rollup part + raw tail part` as one logical stream. Do not add Kafka, Druid, or a new service.

**Tech Stack:** Next.js instrumentation cron, PostgreSQL metadata, ClickHouse MergeTree tables, `@clickhouse/client`, TypeScript, Node test runner.

## Global Constraints

- Do not modify production DB directly.
- Do not use ClickHouse materialized views for rollup writes; prior retry validation showed dependent MV double-count risk.
- Keep `usage_events` as source of truth.
- Keep distinct counts exact: never sum per-bucket `active_users` or `sessions`.
- Low-spec first: bounded compaction batches, no extra container, no new middleware.
- Roll out behind feature flags.

---

## File Structure

- Modify `clickhouse/init/004-rollup.sql`: add `usage_15m_rollup` DDL and keep existing hourly table during migration.
- Modify `packages/storage-clickhouse/src/storage.ts`: add 15-minute bucket helpers, compactor method, and hybrid read path.
- Modify `apps/web/lib/clickhouse-outbox.ts`: add low-frequency compactor tick next to existing outbox flush, guarded by env flags.
- Create migration `migrations/1700000018_clickhouse_rollup_watermark.sql`: store compaction watermark and dirty 15-minute buckets in Postgres.
- Modify `scripts/verify-clickhouse-exact-rollup.ts`: validate raw vs 15m rollup and hybrid query behavior.
- Modify `docs/clickhouse-exact-rollup-runbook.md`: add rollout, validation, rollback, and query-log checks.

## Design Decision

Use a new `usage_15m_rollup` as the base rollup:

```text
15m query  -> usage_15m_rollup + raw tail
30m query  -> 15m rollup rows grouped into 30m + raw tail
hour query -> 15m rollup rows grouped into hour + raw tail
day query  -> 15m rollup rows grouped into day + raw tail
```

The rollup row key must keep dimensions needed for exact distinct counts:

```text
bucket_15m, user_id, team_id, provider_key, model, host, session_id
```

Do not store only `sessions_count` or `active_users_count`; those would double count across 30m/hour/day groupings.

Use a safety delay:

```text
eligible_to = floor15m(now - CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS)
```

The dashboard reads finalized `[from, split)` from rollup and mutable `[split, to)` from raw. `split` is capped by both the watermark and the oldest dirty bucket in the query range, so stale dirty buckets fall back to raw until compaction repairs them.

### Idempotency

Use `ReplacingMergeTree(version)` for `usage_15m_rollup`. The compactor can rebuild a bucket by inserting a newer version for the same rollup key. Query rollup through an `argMax(..., version)` subquery so repeated compaction does not double count before background merges finish.

## Task 1: Schema And Metadata

**Files:**
- Modify: `clickhouse/init/004-rollup.sql`
- Create: `migrations/1700000018_clickhouse_rollup_watermark.sql`
- Modify: `packages/storage-clickhouse/src/storage.ts`

**Interfaces:**
- Produces ClickHouse table `usage_15m_rollup`.
- Produces Postgres tables `clickhouse_rollup_watermarks` and `clickhouse_rollup_dirty_buckets`.
- Produces private helper `fifteenMinuteBucket(ts: Date | string): string`.

- [ ] **Step 1: Add a failing DDL smoke check**

Run:

```bash
AUTH_SECRET=dummy docker compose --profile clickhouse config >/tmp/toard-compose.yml
```

Expected before implementation: no `usage_15m_rollup` DDL exists in `clickhouse/init/004-rollup.sql`.

- [ ] **Step 2: Add ClickHouse DDL**

Add this table after `usage_hourly_rollup` in `clickhouse/init/004-rollup.sql` and `CLICKHOUSE_SCHEMA_DDL`:

```sql
CREATE TABLE IF NOT EXISTS toard.usage_15m_rollup
(
  bucket_15m            DateTime64(3, 'UTC'),
  provider_key          LowCardinality(String),
  user_id               String,
  team_id               String,
  session_id            String,
  model                 LowCardinality(String),
  host                  LowCardinality(String),
  event_count           UInt64,
  input_tokens          UInt64,
  output_tokens         UInt64,
  cache_read_tokens     UInt64,
  cache_creation_tokens UInt64,
  cost_usd              Decimal(18, 8),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(bucket_15m)
ORDER BY (bucket_15m, user_id, team_id, provider_key, model, host, session_id);
```

- [ ] **Step 3: Add Postgres watermark migration**

Create `migrations/1700000018_clickhouse_rollup_watermark.sql`:

```sql
CREATE TABLE IF NOT EXISTS clickhouse_rollup_watermarks (
  name text PRIMARY KEY,
  watermark timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clickhouse_rollup_dirty_buckets (
  name text NOT NULL,
  bucket timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, bucket)
);
```

- [ ] **Step 4: Verify config and typecheck**

Run:

```bash
AUTH_SECRET=dummy docker compose --profile clickhouse config >/tmp/toard-compose.yml
./node_modules/.bin/tsc -p packages/storage-clickhouse/tsconfig.json --noEmit
```

Expected: both commands exit 0.

## Task 2: 15-Minute Rollup Compaction Builder

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `scripts/verify-clickhouse-exact-rollup.ts`

**Interfaces:**
- Produces `compactUsage15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>`
- Existing outbox write path must keep writing only `usage_events` and `usage_hourly_rollup` until hourly rollout is retired.
- `usage_15m_rollup` is written only by the finalized compactor, not by the live outbox flush.

- [ ] **Step 1: Add verification cases**

Extend `scripts/verify-clickhouse-exact-rollup.ts` so it asserts:

```ts
assertDeepEqual(
  await rollup.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
  await raw.getDailyTimeseries({ ...period, bucket: "15m", timezone: "UTC" }),
  "15m raw vs rollup",
);
assertDeepEqual(
  await rollup.getDailyTimeseries({ ...period, bucket: "30m", timezone: "UTC" }),
  await raw.getDailyTimeseries({ ...period, bucket: "30m", timezone: "UTC" }),
  "30m raw vs 15m-rollup regrouped",
);
```

Expected before implementation: these fail because 15m rollup is not compacted/read.

- [ ] **Step 2: Add bucket helper**

Add:

```ts
function fifteenMinuteBucket(ts: Date | string): string {
  const d = new Date(ts);
  const minute = Math.floor(d.getUTCMinutes() / 15) * 15;
  d.setUTCMinutes(minute, 0, 0);
  return chTs(d);
}
```

- [ ] **Step 3: Keep live outbox unchanged**

Verify `insertOutboxRows()` still writes only:

```text
usage_events
usage_hourly_rollup
```

`usage_15m_rollup` must be populated by `compactUsage15mRollup()` after the safety delay. The live outbox marks successfully delivered buckets dirty in Postgres; it does not insert 15m rollup rows directly.

- [ ] **Step 4: Run verification script locally**

Run with local ClickHouse/Postgres test data:

```bash
./node_modules/.bin/tsx scripts/verify-clickhouse-exact-rollup.ts
```

Expected: all raw-vs-rollup assertions pass.

## Task 3: Finalized Compactor

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `apps/web/lib/clickhouse-outbox.ts`

**Interfaces:**
- Produces `compactUsage15mRollup(limitBuckets?: number): Promise<{ buckets: number; rows: number; watermark: string }>`
- Env flags:
  - `CLICKHOUSE_15M_ROLLUP_COMPACTOR=1`
  - `CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS=1800000`
  - `CLICKHOUSE_ROLLUP_MAX_BUCKETS=16`

- [ ] **Step 1: Add compactor method**

Algorithm:

```text
1. Read watermark from clickhouse_rollup_watermarks where name='usage_15m'.
2. If missing, initialize to min(toStartOfInterval(ts, 15m)) from usage_events.
3. Compute eligible_to = floor15m(now - delay).
4. Select a bounded set of dirty buckets older than eligible_to.
5. Select a bounded contiguous backfill range in [watermark, eligible_to).
6. Aggregate raw usage_events FINAL for those buckets into usage_15m_rollup rows with a new version.
7. Insert rows into usage_15m_rollup.
8. Advance watermark only for the contiguous backfill portion after insert succeeds.
9. Delete processed dirty bucket rows after insert succeeds.
```

ClickHouse aggregation shape:

```sql
SELECT
  toStartOfInterval(ts, INTERVAL 15 minute, 'UTC') AS bucket_15m,
  provider_key,
  user_id,
  team_id,
  session_id,
  model,
  host,
  count() AS event_count,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens,
  sum(cache_creation_tokens) AS cache_creation_tokens,
  sum(cost_usd) AS cost_usd
FROM usage_events FINAL
WHERE ts >= {from:DateTime64(3)}
  AND ts < {to:DateTime64(3)}
GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host
```

- [ ] **Step 2: Add guarded scheduler**

In `apps/web/lib/clickhouse-outbox.ts`, add a separate compactor tick. It must:

```text
- run only when STORAGE_BACKEND=clickhouse
- run only when CLICKHOUSE_15M_ROLLUP_COMPACTOR is true
- skip if a prior compactor tick is still running
- log only counts, never secrets
```

- [ ] **Step 3: Verify bounded work**

Run:

```bash
./node_modules/.bin/tsc -p packages/storage-clickhouse/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
```

Expected: both pass. Inspect logs in local compose to confirm compactor advances at most `CLICKHOUSE_ROLLUP_MAX_BUCKETS` per tick.

## Task 4: Hybrid Read Path

**Files:**
- Modify: `packages/storage-clickhouse/src/storage.ts`
- Modify: `scripts/verify-clickhouse-exact-rollup.ts`

**Interfaces:**
- Produces private query helper `rollup15mUnionSource(q, bucket)` that returns a SQL source with:
  - finalized rollup rows for `[from, split)`
  - raw rows for `[split, to)`
- Replaces `canUseRollup()` for time series with `canUse15mHybridRollup()`.
- Keeps old hourly path behind `CLICKHOUSE_READ_ROLLUP` until 15m path is verified.

- [ ] **Step 1: Add feature flag**

Add:

```ts
read15mRollup: readEnvFlag("CLICKHOUSE_READ_15M_ROLLUP", false),
```

Do not reuse `CLICKHOUSE_READ_ROLLUP`; that keeps rollback simple.

- [ ] **Step 2: Build rollup subquery with argMax**

Use a subquery shaped like:

```sql
SELECT
  bucket_15m AS ts,
  provider_key,
  user_id,
  team_id,
  session_id,
  model,
  host,
  argMax(event_count, version) AS event_count,
  argMax(input_tokens, version) AS input_tokens,
  argMax(output_tokens, version) AS output_tokens,
  argMax(cache_read_tokens, version) AS cache_read_tokens,
  argMax(cache_creation_tokens, version) AS cache_creation_tokens,
  argMax(cost_usd, version) AS cost_usd
FROM usage_15m_rollup
WHERE bucket_15m >= {from:DateTime64(3)}
  AND bucket_15m < {split:DateTime64(3)}
GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host
```

Union raw tail rows with the same column names. Then the existing `bucketExpr()` can group into `15m`, `30m`, `hour`, or `day`.

- [ ] **Step 3: Keep overview and leaderboard conservative**

First rollout should use hybrid 15m only for:

```text
getDailyTimeseries
getUserModelTimeseries
```

Keep overview, model breakdown, and leaderboard on the existing hourly/raw path until query-log confirms timeseries is stable. This limits blast radius.

- [ ] **Step 4: Verify exactness**

Run:

```bash
./node_modules/.bin/tsx scripts/verify-clickhouse-exact-rollup.ts
/opt/homebrew/bin/pnpm --filter @toard/core test
/opt/homebrew/bin/pnpm --filter @toard/web test
/opt/homebrew/bin/pnpm --filter @toard/storage-clickhouse typecheck
```

Expected:

```text
15m raw vs hybrid: pass
30m raw vs hybrid: pass
hour raw vs hybrid: pass
day raw vs hybrid: pass
```

## Task 5: Runbook And Rollout

**Files:**
- Modify: `docs/clickhouse-exact-rollup-runbook.md`
- Modify: `docker-compose.yml`

**Interfaces:**
- Documents these rollout env vars:
  - `CLICKHOUSE_15M_ROLLUP_COMPACTOR=1`
  - `CLICKHOUSE_READ_15M_ROLLUP=1`
  - `CLICKHOUSE_ROLLUP_FINALIZE_DELAY_MS=1800000`
  - `CLICKHOUSE_ROLLUP_MAX_BUCKETS=16`

- [ ] **Step 1: Document phases**

Add rollout phases:

```text
Phase 1: deploy schema only, read flags off
Phase 2: enable compactor only
Phase 3: verify raw vs 15m rollup diff
Phase 4: enable 15m hybrid read
Phase 5: observe query_log and app errors
Phase 6: decide whether to retire hourly rollup later
```

- [ ] **Step 2: Add verification SQL**

Add raw-vs-rollup SQL for one day:

```sql
WITH raw AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM toard.usage_events FINAL
  WHERE ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
),
rollup AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation,
    sum(cost_usd) AS cost
  FROM (
    SELECT
      bucket_15m,
      provider_key,
      user_id,
      team_id,
      session_id,
      model,
      host,
      argMax(input_tokens, version) AS input_tokens,
      argMax(output_tokens, version) AS output_tokens,
      argMax(cache_read_tokens, version) AS cache_read_tokens,
      argMax(cache_creation_tokens, version) AS cache_creation_tokens,
      argMax(cost_usd, version) AS cost_usd
    FROM toard.usage_15m_rollup
    WHERE bucket_15m >= {from:DateTime64(3)} AND bucket_15m < {to:DateTime64(3)}
    GROUP BY bucket_15m, provider_key, user_id, team_id, session_id, model, host
  )
)
SELECT
  raw.sessions - rollup.sessions AS sessions_diff,
  raw.active_users - rollup.active_users AS active_users_diff,
  raw.cost - rollup.cost AS cost_diff,
  raw.input - rollup.input AS input_diff,
  raw.output - rollup.output AS output_diff,
  raw.cache_read - rollup.cache_read AS cache_read_diff,
  raw.cache_creation - rollup.cache_creation AS cache_creation_diff
FROM raw CROSS JOIN rollup;
```

- [ ] **Step 3: Add rollback**

Rollback is:

```text
CLICKHOUSE_READ_15M_ROLLUP=
CLICKHOUSE_15M_ROLLUP_COMPACTOR=
docker compose up -d --no-deps --force-recreate app
```

No table drop is required.

## Self-Review

- Spec coverage: hot/cold split, finalized compaction, low-spec operation, exact distinct counts, no new middleware, and rollback are covered.
- Placeholder scan: no `TBD` or unspecified edge handling remains.
- Type consistency: `usage_15m_rollup`, `bucket_15m`, `CLICKHOUSE_READ_15M_ROLLUP`, and `CLICKHOUSE_15M_ROLLUP_COMPACTOR` names are consistent across tasks.
