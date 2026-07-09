# ClickHouse Exact Rollup Runbook

이 문서는 ClickHouse rollup을 운영에서 켜기 전에 확인할 절차를 정리한다.
비밀값은 출력하지 않고, production DB에는 쓰지 않는다.

이번 구조는 materialized view를 쓰지 않는다. 로컬 재시도 검증에서 `usage_events`
insert dedup은 성공해도 dependent MV 결과가 다시 더해질 수 있음이 확인됐기 때문이다.
대신 앱 outbox worker가 같은 배치에서 raw row와 hourly rollup row를 각각 별도
`insert_deduplication_token`으로 쓴다.

`CLICKHOUSE_READ_ROLLUP`은 기본 off다. 운영에서 이 값을 켜기 전까지 대시보드는
기존 raw query path를 사용한다.

## 1. 현재 중복 상태 확인

ClickHouse 컨테이너 안에서 실행한다. 비밀번호는 컨테이너 env를 그대로 사용하고 출력하지 않는다.

```bash
docker compose exec -T clickhouse sh -lc \
  'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  count() AS rows,
  uniqExact(dedup_key) AS uniq_keys,
  rows - uniq_keys AS duplicate_rows
FROM toard.usage_events
FORMAT TSV
SQL
```

`duplicate_rows`가 0이어야 rollup 전환을 검토할 수 있다.

## 2. Postgres outbox 상태 확인

```bash
docker compose exec -T postgres psql "$DATABASE_URL" <<'SQL'
SELECT status, count(*) AS batches
FROM clickhouse_usage_batches
GROUP BY status
ORDER BY status;

SELECT count(*) AS pending_rows
FROM clickhouse_usage_outbox
WHERE delivered_at IS NULL;
SQL
```

`pending_rows`가 계속 증가하면 ClickHouse delivery가 막힌 상태다. 이 경우 `CLICKHOUSE_READ_ROLLUP=1`을 켜면 안 된다.

## 3. backfill / live writer 겹침 금지

대시보드 숫자에 중복이 있으면 안 되므로 backfill과 live rollup writer가 같은 raw
event를 동시에 처리하면 안 된다.

운영에서 `CLICKHOUSE_READ_ROLLUP=1`을 켜려면 다음 중 하나를 만족해야 한다.

- 짧은 write drain 윈도우를 잡고 앱 수집/flush를 멈춘 뒤, outbox pending rows가 0인
  상태에서 과거 raw 데이터를 rollup에 backfill한다.
- 또는 backfill 대상 기간과 live writer 대상 기간이 절대 겹치지 않는 cutoff를 잡고,
  그 cutoff 기준으로 raw-vs-rollup diff가 0임을 확인한다.

이 조건을 만족하지 못하면 rollup table은 만들어져 있어도 `CLICKHOUSE_READ_ROLLUP`을
켜지 않는다.

## 4. raw vs rollup 비교

rollup backfill이 끝난 뒤 같은 기간으로 비교한다.

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
  FROM toard.usage_events
  WHERE ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}
),
rollup AS (
  SELECT
    uniqExactIf(session_id, session_id != '') AS sessions,
    uniqExactIf(user_id, user_id != '') AS active_users,
    sum(cost_usd) AS cost,
    sum(input_tokens) AS input,
    sum(output_tokens) AS output,
    sum(cache_read_tokens) AS cache_read,
    sum(cache_creation_tokens) AS cache_creation
  FROM toard.usage_hourly_rollup
  WHERE bucket_hour >= {from:DateTime64(3)} AND bucket_hour < {to:DateTime64(3)}
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

모든 diff가 0이어야 한다.

## 5. 로컬 백업 검증

운영 데이터를 로컬에서 검증하려면 production에서 직접 쓰지 말고, export 후 로컬 ClickHouse/Postgres에 import한다.

- ClickHouse `usage_events`는 `FORMAT Native` 또는 `FORMAT JSONEachRow`로 export한다.
- Postgres는 `providers`, `users`, `teams`처럼 label/dedup 검증에 필요한 메타만 dump한다.
- 로컬 import 후 `scripts/verify-clickhouse-exact-rollup.ts`와 raw-vs-rollup 비교 SQL을 실행한다.

## 6. 전환 기준

다음 조건이 모두 만족될 때만 `CLICKHOUSE_READ_ROLLUP=1`을 켠다.

- ClickHouse raw duplicate count가 0이다.
- Postgres outbox pending rows가 안정적으로 0으로 돌아온다.
- raw vs rollup diff가 0이다.
- `/api/ready`가 200이고 ClickHouse 컨테이너가 healthy다.

## 7. 운영 전환 절차

전환은 앱 컨테이너만 재시작한다. ClickHouse/Postgres까지 함께 재생성하는
`docker compose up -d` 형태의 전체 apply는 피한다. ClickHouse가 재시작되는 동안
앱이 먼저 요청을 받으면 대시보드 SSR이 일시적으로 실패할 수 있기 때문이다.

```bash
docker compose ps clickhouse
curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready

cp .env ".env.bak.rollup-$(date +%Y%m%d%H%M%S)"
if grep -q '^CLICKHOUSE_READ_ROLLUP=' .env; then
  sed -i.bak 's/^CLICKHOUSE_READ_ROLLUP=.*/CLICKHOUSE_READ_ROLLUP=1/' .env
else
  printf '\nCLICKHOUSE_READ_ROLLUP=1\n' >> .env
fi

docker compose up -d --no-deps --force-recreate app

for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready && break
  sleep 1
done
```

전환 직후 다음을 확인한다.

```bash
docker compose ps app clickhouse
docker compose logs --since=5m app | grep -Ei 'ECONNREFUSED|ENOTFOUND|digest|Error' || true
curl -fsS http://127.0.0.1:${PORT:-3000}/api/ready
```

호스트 `127.0.0.1:${PORT:-3000}`만 connection reset이고 컨테이너 내부 ready는 200이면
Docker 포트 프록시가 꼬인 상태다. 이때는 ClickHouse나 다른 서비스를 건드리지 말고
앱 컨테이너만 재시작한다.

```bash
docker compose restart app
```

문제가 있으면 `CLICKHOUSE_READ_ROLLUP`을 빈 값으로 되돌리고 앱만 재시작하면 raw query path로 복귀한다.
