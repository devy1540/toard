# 가격 미확정 데이터 완전 자동 복구 설계

## 목적

가격표 동기화가 성공했는데도 기존 사용량이 `unpriced`로 남아 비용 합계가 계속 불완전한 문제를 해결한다. 관리자는 가격 동기화, 재가격, rollup 재생성 순서를 알거나 버튼을 누를 필요가 없어야 한다. 앱이 가격표 동기화부터 미확정 이벤트 복구, rollup 재계산, 정합성 검증까지 자동으로 완료하고 관리 화면은 관측 정보만 제공한다.

성공 기준은 다음과 같다.

- 앱 기동과 일 1회 가격 동기화가 별도 cron이나 관리자 조작 없이 계속 동작한다.
- 가격표 동기화가 끝나면 적용 가능한 `unpriced` 이벤트를 자동으로 찾아 비용을 확정한다.
- 가격이 이미 확정된 `priced` 이벤트와 이전 체계의 `legacy` 이벤트는 변경하지 않는다.
- 같은 모델의 날짜별 가격 변경은 revision으로 보존한다.
- PostgreSQL과 ClickHouse 저장 모드에서 같은 비용과 provenance를 만든다.
- ClickHouse 복구 중 준비되지 않은 rollup은 읽지 않고 더 세밀한 source로 대체 조회한다.
- 복구 작업은 작은 batch와 기존 전역 부하 슬롯을 사용해 수집과 사용자 조회를 방해하지 않는다.
- 실패는 자동 재시도하고, 가격표에 없는 모델도 이후 동기화에서 가격이 생기면 자동 복구한다.
- 관리자 화면과 사용자 경고는 조작 지시 대신 현재 자동 복구 상태와 남은 미확정 건수만 보여준다.

## 현재 문제와 원인

현재 가격 동기화는 LiteLLM 가격표를 내려받아 `pricing_revisions`에 새 revision을 추가하고 성공 날짜를 저장한다. 모델 수와 마지막 동기화 날짜는 이 가격표 상태만 나타낸다.

사용량 비용은 수집 시점에 이벤트 발생 시각 이하의 마지막 revision으로 한 번 확정된다. 적용 가능한 revision이 없으면 `cost_status = 'unpriced'`, `cost_usd = 0`으로 저장된다. 이후 가격표가 추가돼도 기존 이벤트를 다시 계산하는 worker가 없으므로 경고가 계속 남는다.

revision의 `effective_at`도 동기화가 실제 실행된 시각으로 기록된다. 오전에 발생한 이벤트를 오후에 처음 동기화하면 같은 조직 날짜의 가격인데도 오전 이벤트에는 적용할 수 없다. 새 설치가 과거 90일 로그를 처음 수집하는 경우에도 최초 가격 revision보다 이벤트 시각이 과거라 대부분 미확정이 될 수 있다.

과거에 전체 보존 데이터 재가격 기능이 있었지만 PostgreSQL만 지원했고 현재 가격을 모든 과거 이벤트에 덮어쓰며 ClickHouse rollup을 안전하게 재생성하지 못해 제거됐다. 이번 설계는 `unpriced`만 복구하고 revision provenance와 rollup invalidation을 함께 처리한다.

## 선택한 접근법

### 채택: 날짜 단위 revision과 durable 자동 복구 worker

가격 동기화가 만든 revision의 적용 시각을 조직 날짜의 실제 시작 시각으로 맞춘다. 가격 이력이 전혀 없는 모델에는 보존 범위 시작 시각의 bootstrap revision을 한 번 추가한다. 이후 가격이 달라진 날짜마다 새 revision을 추가해 날짜별 변경을 유지한다.

동기화 성공은 durable 복구 작업을 깨운다. worker는 `unpriced` 이벤트 중 revision으로 계산 가능한 항목만 batch 처리하고, 영향받은 rollup bucket을 재계산 대상으로 만든다. worker와 rollup은 같은 coordinator 부하 슬롯을 공정하게 공유한다.

### 제외한 접근법

1. **관리자가 모델과 적용일을 입력**: 가장 보수적이지만 운영자가 계속 판단해야 하므로 제품 요구와 맞지 않는다.
2. **수동 동기화 요청에서 전체 재가격**: HTTP 요청이 오래 걸리고 ClickHouse mutation과 rollup 재계산이 겹쳐 타임아웃과 부하 위험이 크다.
3. **현재 가격을 모든 과거 `priced`·`legacy` 데이터까지 덮어쓰기**: 날짜별 가격 이력과 기존 provenance를 파괴하므로 제외한다.

## 전체 흐름

```text
앱 기동 10초 후 또는 일 1회 자동 가격 동기화
  -> LiteLLM 가격표 검증
  -> 조직 날짜 시작 시각의 변경 revision 저장
  -> 필요한 bootstrap revision 저장
  -> pricing generation 갱신
  -> 자동 복구 작업 pending

가격 복구 worker
  -> unpriced 모델과 적용 가능한 revision 확인
  -> 최대 500건 claim
  -> revision 가격으로 비용 계산
  -> raw usage를 priced 새 버전으로 저장
  -> 영향받은 15분 bucket을 dirty 처리
  -> 완료/남은 건수 저장

기존 rollup coordinator
  -> 15분 기준 rollup 재계산
  -> 시간대별 1시간·1일 rollup 후속 재계산
  -> 정합성 검증
  -> 준비된 구간부터 자동 rollup 읽기
```

가격표 동기화 HTTP action 안에서 사용량 재계산을 실행하지 않는다. 동기화 transaction은 가격 revision과 generation만 확정하고 즉시 끝난다. 데이터 복구는 앱 프로세스의 durable worker가 이어서 수행한다.

## 가격 revision 정책

### 일별 적용 시각

LiteLLM 동기화는 조직 날짜 단위로 한 번 실행되므로 변경 revision의 `effective_at`은 요청 시각이 아니라 `firstInstantOfLocalDate(day, ORG_TIMEZONE)`로 기록한다. DST로 자정이 없거나 UTC offset이 30분·45분인 시간대도 기존 timezone resolver를 사용한다.

같은 모델의 최신 가격과 값이 같으면 새 revision을 만들지 않는다. 가격이 달라졌으면 해당 조직 날짜 시작부터 새 가격을 적용한다. 따라서 날짜 A의 이벤트는 A 이하의 마지막 revision, 날짜 B의 변경 이후 이벤트는 B revision을 사용한다.

### 최초 bootstrap

현재 가격표에는 과거 가격의 적용일이 포함되지 않는다. 최초 설치나 기존 데이터 업그레이드에서는 과거 이벤트에 적용할 revision이 전혀 없을 수 있다. 완전 자동 복구를 위해 모델별 가장 오래된 저장 revision의 가격을 사용해 논리 보존 범위 시작 시각에 `source = 'litellm-bootstrap'` revision을 한 번 추가한다.

bootstrap은 다음 제약을 가진다.

- 모델별 한 번만 생성한다.
- 기존 revision을 수정하거나 삭제하지 않는다.
- bootstrap 이후의 실제 날짜별 revision이 항상 우선한다.
- `observed_at`은 실제 생성 시각을 유지해 사후에 bootstrap 추정임을 감사할 수 있다.
- 이벤트가 존재하지 않는 과거 구간에 revision이 생기는 것은 비용 합계에 영향을 주지 않는다.

과거 가격 source가 없는 범위에서는 어떤 자동 시스템도 완전한 역사 가격을 재구성할 수 없다. bootstrap은 비용을 영구히 $0으로 두는 대신 최초 관측 가격을 보존 범위에 적용하는 명시적이고 결정론적인 정책이다. 이후 가격 변경은 날짜별 revision으로 정확히 분리된다.

### 가격표에 없는 모델

기존 canonical alias resolver를 그대로 사용한다. vendor prefix, 날짜 suffix, 검증된 fuzzy alias로 revision을 찾을 수 있으면 자동 복구한다. 전혀 매칭되지 않으면 가격을 만들지 않고 `unpriced`로 유지한다.

worker는 동기화 generation마다 미확정 모델을 다시 평가한다. LiteLLM에 해당 모델이나 매칭 가능한 canonical 모델이 추가되는 날 별도 관리자 조작 없이 자동 복구된다. 반복 실패를 오류로 취급하지 않고 `waiting_for_catalog` 상태로 집계한다.

## durable 작업 상태

PostgreSQL migration으로 단일 상태 행 `pricing_repair_status`를 추가한다.

- `generation`: 가격 동기화 성공 시각
- `state`: `idle | pending | running | waiting_for_catalog | failed`
- `target_to`: 이번 복구가 대상으로 삼는 고정 시각
- `processed_events`, `recovered_events`, `remaining_unpriced_events`
- `last_started_at`, `last_succeeded_at`, `last_error`
- `adaptive_limit`, `load_state`, `updated_at`

가격 sync transaction에서 revision과 sync 상태를 저장한 뒤 같은 transaction으로 상태를 `pending`으로 갱신한다. `target_to`는 sync가 성공한 시각으로 고정한다. 이후 들어오는 이벤트는 새 revision schedule로 즉시 가격이 확정되므로 신규 데이터가 기존 작업 완료를 계속 밀지 않는다.

프로세스가 중단돼도 `pending` 또는 오래된 `running` 상태를 다음 replica가 이어받는다. 실패는 60초부터 최대 5분까지 backoff하고 성공 전까지 generation과 누적 수치를 유지한다.

## PostgreSQL 복구

worker는 transaction 안에서 다음 조건의 이벤트를 최대 adaptive limit만큼 잠근다.

```sql
cost_status = 'unpriced'
AND ts < target_to
AND ts >= logical_retention_start
FOR UPDATE SKIP LOCKED
```

각 이벤트는 `resolveCostAt`으로 다시 계산한다. 적용 가능한 revision이 있는 이벤트만 `cost_usd`, `pricing_revision_id`, `cost_status = 'priced'`로 갱신한다. 매칭되지 않는 행은 수정하지 않는다.

변경된 조직 날짜를 기존 daily recompute 대상으로 표시한다. transaction이 실패하면 이벤트와 dirty 상태가 함께 rollback된다.

## ClickHouse 복구

`usage_events`는 `ReplacingMergeTree(inserted_at)`이고 `dedup_key`가 정렬 키이므로 기존 행을 mutation으로 UPDATE하지 않는다. `usage_events FINAL`에서 `unpriced` 이벤트를 읽고 같은 `dedup_key`와 토큰·사용자·팀·세션 값을 유지한 채 비용과 revision만 바꾼 새 행을 INSERT한다. 더 늦은 `inserted_at`의 행이 canonical 버전이 된다.

ClickHouse와 PostgreSQL 사이에 단일 transaction은 없으므로 정확한 순서를 지킨다.

1. 영향받을 15분 bucket을 PostgreSQL에서 dirty로 먼저 기록한다.
2. ClickHouse에 replacement 행을 idempotent insert token으로 기록한다.
3. 성공한 event key와 worker 진행 상태를 durable하게 기록한다.
4. 실패하면 dirty는 남아 rollup 읽기가 raw fallback을 사용하고 다음 실행이 같은 replacement를 재시도한다.

repair insert token은 `pricing-repair:<generation>:<정렬된 batch dedup-key 목록>`의 결정론적 hash를 사용한다. 재시도 중 중복 insert가 생겨도 `ReplacingMergeTree`의 canonical FINAL 결과는 하나다.

기존 `usage_hourly_rollup`에 증분 비용을 더하지 않는다. 15분 v2 dirty compaction이 `usage_events FINAL`에서 해당 bucket 전체를 다시 만들고, 시간대별 hour/day job이 후속 재계산한다. 이 경로는 이전 unpriced 행과 새 priced 행을 동시에 더하는 일을 막는다.

## 부하 제어와 공정성

가격 복구는 별도 무거운 timer로 경쟁하지 않고 기존 RollupCoordinator의 후보 `pricing_repair`로 들어간다. 전역 `toard:rollup-load-slot`을 보유한 coordinator가 한 주기에 다음 작업 중 하나만 실행한다.

- 가격 미확정 복구
- 15분 기준 rollup
- 시간대별 1시간·1일 rollup
- 정합성 검증

초기 batch는 100 event, 최소 25, 최대 500이다.

- 요청한 batch를 모두 처리하고 2초 이하이면 다음 한도를 25% 늘린다.
- 10초 이상 걸리거나 실패하면 다음 한도를 절반으로 줄인다.
- 처리할 수 있는 가격이 없는 미확정 모델은 batch 처리량에 포함하지 않는다.
- 신규 수집 outbox flush는 기존처럼 부하 슬롯 밖에서 계속 실행한다.
- 처리 가능한 가격 복구 작업도 기존 공정성의 120초 starvation 한도를 적용한다.

## 조회 정합성

PostgreSQL 모드에서는 event update와 daily dirty가 같은 transaction이므로 재계산 전 준비되지 않은 Mart를 사용하지 않는다.

ClickHouse 모드에서는 replacement 전에 15분 bucket을 dirty로 표시한다. 활성 rollup 조회도 dirty coverage를 사용하지 않고 `usage_events FINAL`로 대체 조회한다. 15분 compaction이 새 priced 버전을 집계하고 fingerprint 검증을 통과한 뒤에만 해당 bucket을 다시 rollup에서 읽는다. 시간대별 hour/day도 기존 generation과 coverage 규칙으로 후속 확정한다.

비용 합계의 완료 조건은 현재 조회 범위의 `unpriced_events = 0`이다. worker 상태가 성공이어도 가격표에 없는 모델이 남아 있으면 완료 비용으로 표시하지 않는다.

## 관리자와 사용자 화면

관리자가 수행해야 하는 가격 관련 작업은 없다.

- `지금 동기화` 버튼과 자동 동기화 on/off 토글을 제거한다.
- 인프라용 `PRICING_AUTO_SYNC=off` kill switch는 유지한다.
- 가격 카드에는 마지막 가격표 갱신, 자동 복구 상태, 복구 수, 남은 미확정 수를 표시한다.
- 진행 중이면 `가격 확인 중 · 자동으로 반영됩니다`를 표시한다.
- 가격표에 없는 모델만 남으면 `가격표 지원 대기 · 다음 동기화에서 자동 재확인합니다`를 표시한다.
- 오류가 발생해도 사용자에게 관리자 페이지 이동을 요구하지 않고 `자동 재시도 중`을 표시한다.
- 대시보드 경고의 기존 `관리 → 시스템에서 실행` 안내를 제거한다.

운영자가 장애를 진단할 수 있도록 관리자 상태 API에는 모델별 미확정 event 수와 첫/마지막 시각을 상위 20개까지만 제공한다. 이 정보는 관측용이며 입력이나 승인 UI는 만들지 않는다.

## 실패와 복구

- LiteLLM fetch 실패: 기존 snapshot을 유지하고 한 시간 뒤 자동 재시도한다. 복구 generation을 바꾸지 않는다.
- 가격 sync transaction 실패: revision과 repair pending을 함께 rollback한다.
- 적용 가능한 가격 없음: 이벤트를 수정하지 않고 `waiting_for_catalog`로 남긴다.
- PostgreSQL worker 종료: row lock이 해제되고 다음 실행이 다시 claim한다.
- ClickHouse replacement 후 상태 기록 실패: dirty fallback을 유지하고 결정론적 token으로 재시도한다.
- rollup 재계산 실패: raw/더 세밀한 source fallback을 유지한다.
- 정합성 mismatch: 기존 자동 cutover 규칙대로 해당 rollup을 즉시 fallback한다.
- 여러 replica: pricing advisory lock과 coordinator 전역 lock으로 중복 heavy 작업을 막는다.

## 배포와 호환성

1. additive migration으로 `pricing_repair_status`를 추가한다.
2. 앱 시작 시 기존 가격 revision에 bootstrap이 없으면 earliest revision 가격으로 보존 시작 revision을 추가한다.
3. 가격 동기화 revision은 이후부터 조직 날짜 시작 시각을 사용한다.
4. 앱 기동 후 자동 sync가 성공하면 기존 `unpriced` 데이터가 자동 복구되기 시작한다.
5. 기존 rollup worker 상태, watermark, pause와 읽기 전환 상태는 초기화하지 않는다.
6. 구버전으로 롤백하면 additive table과 bootstrap revision은 남지만 구버전이 무시할 수 있어야 한다.
7. 데이터 삭제, 원본 TTL 활성화, 기존 revision UPDATE는 수행하지 않는다.

## 구현 경계

주요 변경 대상은 다음과 같다.

- 가격 sync의 날짜 시작 revision과 bootstrap 생성
- 신규 `apps/web/lib/pricing-repair.ts`와 저장소별 adapter
- `StorageBackend`의 미확정 복구용 제한 인터페이스
- PostgreSQL batch update와 ClickHouse replacement insert
- RollupCoordinator의 `pricing_repair` 후보와 adaptive 상태
- PostgreSQL additive migration과 통합 테스트
- 관리자 status API와 가격 상태 카드
- 대시보드 경고 한국어·영어 문구
- README 가격 자동화 설명

범위에서 제외한다.

- 이미 확정된 `priced` 이벤트의 재가격
- `legacy` 이벤트 변경
- 임의 모델 가격 입력 UI
- 가격표 source를 LiteLLM 외 여러 공급자로 확장
- 원본 TTL 자동 활성화
- 관리자가 worker 처리량을 직접 입력하는 기능

## 검증 기준

- sync 시각이 오후여도 revision이 조직 날짜 시작 시각으로 저장되는지 테스트한다.
- DST 전환일과 30분·45분 offset 조직 시간대의 revision 경계를 테스트한다.
- 기존 revision이 있는 모델의 bootstrap이 earliest revision 가격을 사용하고 한 번만 생성되는지 테스트한다.
- 같은 가격은 revision을 중복 생성하지 않고 가격 변경일만 새 revision을 만드는지 테스트한다.
- `unpriced`만 복구하고 `priced`·`legacy`는 변경하지 않는지 테스트한다.
- 가격표에 없는 모델은 수정하지 않고 이후 generation에서 자동 복구되는지 테스트한다.
- PostgreSQL transaction rollback과 `FOR UPDATE SKIP LOCKED` 동시 실행을 통합 테스트한다.
- ClickHouse replacement 재시도, `FINAL` 단일 결과, dirty-before-insert 순서를 통합 테스트한다.
- 복구 전후 raw와 15분·시간대별 rollup의 event·token 합계는 같고 비용·revision·status만 의도대로 바뀌는지 fingerprint로 검증한다.
- 백필 동시 실행 benchmark에서 기준 4 vCPU·8 GiB 환경의 인증된 대시보드 8개 시나리오가 p95 2초 이하이고 5xx가 없어야 한다.
- 전체 `pnpm typecheck`, `pnpm test`, 웹 production build, `git diff --check`를 통과한다.
