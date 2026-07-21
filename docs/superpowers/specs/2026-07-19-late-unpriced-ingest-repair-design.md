# 늦게 수집된 가격 미확정 이벤트 자동 복구 설계

## 목적

하루 가격표 동기화와 가격 복구가 끝난 뒤 과거 사용량이 새로 수집되더라도 `unpriced` 이벤트가 자동 복구 대기열에 들어가게 한다. 관리자가 가격 동기화를 다시 실행하지 않아도 PostgreSQL과 ClickHouse 저장 모드가 같은 방식으로 복구를 시작해야 한다.

성공 기준은 다음과 같다.

- 실제로 새로 저장된 `unpriced` 이벤트가 있으면 같은 저장 transaction에서 복구 요청이 durable하게 기록된다.
- 전부 중복 처리된 batch와 `priced` 또는 `legacy` 이벤트만 저장한 batch는 복구 작업을 깨우지 않는다.
- 가격 복구 worker 실행 중 신규 미확정 이벤트가 들어와도 현재 generation을 취소하거나 굶기지 않는다.
- 현재 worker가 고정한 범위 뒤의 요청은 다음 batch가 이어받는다.
- PostgreSQL과 ClickHouse outbox가 같은 enqueue 규칙을 사용한다.
- 업그레이드 시 이미 남아 있는 미확정 이벤트도 별도 관리자 조작 없이 한 번 재검사된다.
- 기존 가격 이력 복구, retry backoff, rollup dirty 처리와 비용 provenance는 바꾸지 않는다.

## 재현 결과와 원인

개인 Kubernetes 설치에서 2026-07-19 18:53 KST 기준 `gpt-5.6-sol` 미확정 이벤트 82건이 남았다. 이벤트 발생 시각은 03:16~08:59 KST이고 최초 authoritative 가격 revision은 09:00 KST부터 유효했다.

가격 자동 동기화는 17:28 KST에 성공했고 가격 복구는 17:29 KST에 처리 대상 0건으로 `idle`이 됐다. 과거 사용량은 그 뒤 shim 초기 전송으로 저장됐다. 저장 경로는 `unpriced` 이벤트를 그대로 삽입하지만 `pricing_repair_status`를 다시 `pending`으로 만들지 않는다. 일 1회 가격 동기화는 이미 성공했으므로 이후 매시간 tick도 같은 날에는 동기화를 건너뛴다. 결과적으로 과거 가격 이력 worker를 시작할 durable 후보가 만들어지지 않았다.

## 접근법 비교

### 채택: 저장 transaction의 병합 가능한 복구 요청

PostgreSQL은 실제 `unpriced` 행을 하나 이상 새로 저장한 경우 usage transaction 안에서 공통 enqueue 함수를 batch당 한 번 호출한다. ClickHouse는 outbox의 `unpriced` 행을 ClickHouse에 전달한 뒤 delivery를 확정하는 PostgreSQL transaction에서 호출한다. 실행 중인 worker와 새 요청을 분리하기 위해 `pricing_repair_status.queued_target_to`를 둔다.

현재 작업이 없으면 즉시 새 generation을 `pending`으로 시작한다. 작업이 이미 `pending`, `running`, `waiting_for_catalog`, `failed`라면 현재 상태와 generation을 덮어쓰지 않고 요청 범위만 `queued_target_to`에 합친다. worker가 claim하거나 현재 batch를 마칠 때 대기 범위를 `target_to`에 병합한다.

### 제외: API 저장 후 callback

수집 route가 `saveUsageEvents` 반환 뒤 복구 상태를 갱신하는 방식은 저장 commit과 enqueue 사이에 프로세스가 종료되면 요청이 유실된다. `/api/v1/events`와 `/api/v1/logs`에 같은 로직도 반복된다.

### 제외: 주기적인 전체 미확정 검색

worker가 매시간 전체 저장소를 검색하면 eventual recovery는 가능하지만 최대 한 시간 지연되고 데이터 증가에 따라 불필요한 진단 query가 계속 실행된다. 이번 문제는 저장 시점을 알고 있으므로 event-driven enqueue가 더 정확하다.

## 데이터 모델

`pricing_repair_status`에 nullable `queued_target_to TIMESTAMPTZ`를 추가한다.

- `target_to`: worker가 현재 claim에서 처리하기로 고정한 상한
- `queued_target_to`: 현재 claim 이후 들어왔거나 아직 claim에 병합되지 않은 요청 상한

요청 상한은 DB의 `clock_timestamp()`를 사용한다. 수집 finalizer의 `receivedAt`보다 transaction 시각이 늦으므로 허용된 이벤트의 `ts < target_to` 조건을 만족한다. 여러 요청은 `GREATEST`로 병합해 단일 watermark만 유지한다.

공통 PostgreSQL 함수 `enqueue_pricing_repair(TIMESTAMPTZ)`를 migration으로 추가한다. 함수는 다음 규칙을 적용한다.

1. 상태가 `idle`이거나 generation/target이 비어 있으면 새 generation과 target을 만들고 `pending`으로 전환한다.
2. 그 외 상태에서는 generation, retry 상태, 진행 수치를 보존하고 `queued_target_to`만 확장한다.
3. `waiting_for_catalog`와 `failed`의 `next_attempt_at`을 앞당기지 않는다. 지원되지 않는 모델이 계속 수집돼 외부 가격 source를 과도하게 재시도하는 것을 막는다.
4. 함수 호출과 usage/outbox insert는 같은 PostgreSQL transaction에서 commit 또는 rollback된다.

## 저장 경로

### PostgreSQL

`PostgresStorage.saveUsageEvents`는 각 `INSERT ... ON CONFLICT DO NOTHING`의 실제 `rowCount`와 이벤트의 `costStatus`를 함께 확인한다. 새로 삽입된 `unpriced` 행이 하나 이상이면 usage insert loop 뒤, commit 전에 enqueue 함수를 한 번 호출한다.

중복된 `unpriced` 이벤트는 `rowCount = 0`이므로 요청을 만들지 않는다. `legacy`는 이번 자동 복구의 신규 트리거가 아니다. 기존 migration 또는 가격 sync가 legacy 재가격 generation을 시작하는 정책을 유지한다.

### ClickHouse

ClickHouse 모드는 먼저 PostgreSQL `clickhouse_usage_outbox`에 durable하게 저장한다. 이 단계에서는 아직 복구를 예약하지 않는다. `flushUsageOutbox`가 해당 batch를 ClickHouse `usage_events`에 idempotent insert한 뒤, outbox와 batch의 delivery를 확정하는 PostgreSQL transaction에서 batch row 중 `unpriced`가 하나라도 있으면 enqueue 함수를 한 번 호출한다.

따라서 worker가 복구 요청을 볼 때는 ClickHouse insert가 이미 성공한 상태다. delivery transaction 또는 enqueue 함수가 실패하면 outbox batch는 다시 `pending`으로 돌아가고, 같은 ClickHouse insert token으로 재전달한 뒤 enqueue를 재시도한다. ClickHouse insert는 성공했지만 PostgreSQL commit이 실패한 경계에서도 요청이 유실되지 않는다.

## worker 동시성

### claim

`PgPricingRepairRepository.claim`은 row를 `running`으로 바꾸는 같은 SQL에서 `queued_target_to`를 현재 `target_to`에 병합하고 queue를 비운다. 반환되는 claim은 병합된 고정 상한을 사용한다.

### 실행 중 신규 요청

worker가 `target_to = T1`을 claim한 뒤 신규 미확정 데이터가 들어오면 enqueue 함수는 `queued_target_to = T2`만 기록한다. 현재 generation은 그대로여서 진행 결과가 superseded되지 않는다.

### 진행 결과 저장

`markProgress`는 같은 generation을 갱신할 때 `queued_target_to`가 있으면 계산한 terminal 상태보다 대기 요청을 우선한다.

- `target_to = GREATEST(target_to, queued_target_to)`
- `queued_target_to = NULL`
- 다음 상태는 `pending`
- `next_attempt_at = 현재 진행 저장 시각`
- `eligible_since`는 기존 값 또는 현재 시각을 유지

현재 batch가 자체적으로 `pending`을 반환한 경우에도 동일하게 queue를 병합한다. 다음 claim이 확장된 상한까지 처리한다. queue가 없으면 기존 `idle`, `waiting_for_catalog`, `pending` 전이와 backoff를 그대로 적용한다.

`markFailed`는 queue를 보존한다. backoff 후 claim이 이를 병합해 재시도한다.

## 기존 데이터 업그레이드

additive migration은 컬럼과 enqueue 함수를 만든 뒤 enqueue 함수를 한 번 호출한다. 데이터 존재 여부를 migration에서 저장소별로 직접 세지 않는다. 미확정 데이터가 없으면 worker가 빈 scan 한 번으로 `idle`에 돌아가고, 데이터가 있으면 기존 저장소 진단과 historical pricing 경로가 처리한다.

이 one-shot 요청으로 현재 개인 서버의 82건도 새 버전 배포 후 대상이 된다. 과거 가격 근거를 찾을 수 있는지는 기존 LiteLLM Git history 정책이 결정하며, 근거가 없으면 이벤트는 수정하지 않고 `waiting_for_catalog`로 남긴다.

down migration은 공통 함수를 제거하고 `queued_target_to` 컬럼을 제거한다. 기존 usage, revision, history job은 삭제하지 않는다.

## 실패 처리

- usage insert 실패: transaction rollback으로 enqueue도 남지 않는다.
- enqueue 함수 실패: usage/outbox transaction 전체를 rollback해 저장됐지만 복구 요청이 없는 상태를 만들지 않는다.
- ClickHouse flush 실패: outbox와 복구 요청은 남고 기존 flush retry가 이어진다.
- worker 실행 중 추가 enqueue: queue watermark로 다음 batch에 병합한다.
- 외부 가격 source rate limit: 기존 `waiting_source`와 retry 시각을 유지한다.
- 여러 replica 동시 수집: singleton row update와 `GREATEST`가 요청을 직렬화하고 가장 늦은 상한을 보존한다.

## 테스트

### migration 및 repository

- migration이 nullable queue 컬럼과 enqueue 함수를 추가하고 업그레이드 one-shot을 실행한다.
- `idle` enqueue가 새 pending generation을 만든다.
- `running` enqueue가 generation을 바꾸지 않고 queue만 확장한다.
- 더 이른 요청이 더 늦은 queue watermark를 줄이지 않는다.
- claim이 queue를 target에 병합하고 queue를 비운 값을 반환한다.
- 실행 중 enqueue 뒤 `markProgress`가 terminal 결과를 `pending`으로 전환한다.
- 실패 상태의 backoff와 queue가 함께 보존된다.

### 저장소

- PostgreSQL에서 새 `unpriced`가 하나 이상 삽입되면 batch당 enqueue 한 번이다.
- PostgreSQL에서 전부 dedup되거나 priced/legacy만 있으면 enqueue하지 않는다.
- ClickHouse는 outbox 저장만으로 enqueue하지 않고, 실제 delivery가 성공한 `unpriced` batch에서 한 번 enqueue한다.
- PostgreSQL enqueue 실패 시 usage insert가 rollback되고, ClickHouse delivery enqueue 실패 시 outbox batch가 재시도 상태로 돌아간다.

### 통합 회귀

1. 가격 sync와 repair가 먼저 `idle`이 된다.
2. 적용 가능한 현재 revision보다 과거인 `unpriced` 이벤트를 늦게 수집한다.
3. 별도 가격 sync 호출 없이 repair가 `pending`이 된다.
4. historical job과 pricing repair가 기존 정책대로 이어진다.
5. worker 실행 중 두 번째 batch를 수집해도 첫 generation이 완료되고 두 번째 범위가 다음 claim에서 처리된다.

## 범위 제외

- 가격 source나 historical pricing 알고리즘 변경
- 가격 근거가 없는 모델을 현재 가격으로 임의 소급
- `priced` 이벤트 재가격 정책 변경
- dashboard 문구 또는 관리자 조작 UI 변경
- rollup coordinator 공정성 및 batch 크기 정책 변경
- 조직 타임존 기본값 변경

## 검증 기준

- 신규 회귀 테스트가 수정 전 실패하고 수정 후 통과한다.
- PostgreSQL과 ClickHouse 저장소 테스트가 통과한다.
- pricing repair, pricing history, rollup coordinator 테스트가 통과한다.
- migration integration test가 up/down 및 기존 데이터 one-shot을 확인한다.
- 전체 typecheck, test, production build, `git diff --check`를 통과한다.
- 개인 Kubernetes에 새 이미지를 배포한 뒤 DB 상태가 `pending/running`으로 전환되고 기존 82건이 historical recovery 또는 명시적인 `waiting_for_catalog` 결과로 이동하는 것을 확인한다.
