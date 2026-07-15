# 전체 보존분 레거시 가격 자동 복구 설계

## 배경

가격 revision 도입 이전에 저장된 사용 이벤트는 migration에서 `cost_status = 'legacy'`를 받았다. 이 값은 당시 저장된 비용을 보존하기 위한 안전장치였고, 현재 대시보드는 조회 범위에 남아 있는 `legacy` 이벤트 수를 `{count}건은 이전 가격 기준`으로 표시한다.

현재 자동 가격 복구는 `unpriced` 이벤트와 비권위 bootstrap revision만 처리한다. 과거 가격 이력 복구가 성공하고 `남은 미확정`이 0이 되어도 `legacy`는 선택 조건에 들어가지 않으므로 사용자 화면의 이전 가격 기준 문구가 계속 남는다.

이번 변경은 현재 90일 논리 보존 범위에 제한된 복구를 확장해, 저장소에 실제로 남아 있는 전체 `legacy` 이벤트를 발생 시각의 권위 있는 LiteLLM Git 가격 이력으로 재계산한다.

## 목표

- PostgreSQL 또는 ClickHouse에 남아 있는 전체 `legacy` 이벤트를 자동 복구 대상으로 삼는다.
- 발생 시각에 적용 가능한 권위 있는 가격 revision이 확인된 이벤트만 `priced`로 전환한다.
- 가격 근거가 없거나 이벤트 메타데이터가 불충분하면 기존 비용과 `legacy` 상태를 보존한다.
- 비용 외의 토큰, 사용자, 팀, 세션, 모델, 호스트, 발생 시각은 변경하지 않는다.
- ClickHouse의 15분 및 시간대별 1시간·1일 rollup을 기존 dirty/coverage 보호 규칙으로 다시 만든다.
- 작업이 중단되거나 프로세스가 재시작돼도 이미 완료한 이벤트를 다시 변경하지 않고 이어서 처리한다.
- 관리 화면에서 전체 legacy 재가격 완료 수와 남은 수를 확인할 수 있게 한다.
- 남은 legacy가 0이 된 조회 범위에서는 기존 사용자 화면의 `이전 가격 기준` 문구가 자연스럽게 사라지게 한다.

## 비목표

- 현재 최신 가격을 과거 전체에 소급 적용하지 않는다.
- LiteLLM Git 이력에 없는 가격을 추정하거나 관리자가 입력한 임시 가격으로 채우지 않는다.
- 원본 이벤트를 삭제하거나 TTL 설정을 변경하지 않는다.
- authoritative `priced` 이벤트를 최신 가격으로 다시 계산하지 않는다.
- migration SQL에서 사용 이벤트 비용을 대량 갱신하지 않는다.
- 운영 데이터베이스를 수동으로 직접 수정하는 절차를 추가하지 않는다.

## 선택한 접근법

### 원본 이벤트 단위의 권위 있는 역사 가격 재계산

저장소에 남아 있는 각 `legacy` 이벤트를 기존 자동 복구 worker가 제한된 batch로 읽는다. resolver는 이벤트의 모델, 발생 시각, 토큰 구성과 모드를 사용해 해당 시각의 authoritative revision을 찾고 비용을 계산한다. 근거 revision이 확인된 경우에만 비용, `pricing_revision_id`, `cost_status`를 원자적으로 교체한다.

이 접근법은 rollup을 직접 재가격하는 방식보다 느리지만, 이벤트별 토큰 구성과 가격 provenance를 보존하고 PostgreSQL과 ClickHouse에서 같은 계산 계약을 사용할 수 있다.

## 제외한 접근법

### Rollup 단위 재가격

집계 행만 다시 계산하면 빠르지만 이벤트별 fast mode, 200k 초과 tier, cache read·creation 구성을 정확히 재현하기 어렵다. 비용은 원본 이벤트에서 결정한다는 현재 구조와도 어긋나므로 제외한다.

### 현재 가격 일괄 적용

현재 LiteLLM 가격표를 모든 과거 이벤트에 적용하면 과거 가격 변경 시점을 잃고 비용을 왜곡한다. 사용자 화면의 문구는 빠르게 사라지지만 숫자의 근거를 설명할 수 없으므로 제외한다.

## 복구 범위

### 시간 범위

기존 worker의 `target_to - 90일` 하한을 제거한다. 매 generation은 저장소가 보유한 이벤트 중 다음 조건에 해당하는 모든 행을 대상으로 한다.

```text
cost_status IN ('unpriced', 'legacy')
OR pricing_revision_id IN (authoritative = FALSE인 revision ID)
```

상한 `target_to`는 generation 시작 시 고정한다. 작업 중 새 이벤트가 들어와도 현재 generation의 상한은 움직이지 않는다. 이후 가격 sync 또는 신규 복구 신호가 새 generation을 만들면 그때 새 상한까지 처리한다.

전체 보존분은 달력상 고정 기간이 아니라 저장소에 실제로 남아 있는 canonical 사용 이벤트 전체를 뜻한다. 설치별 TTL 또는 과거 데이터 보유 차이를 추정하지 않는다.

### 상태별 처리

| 현재 상태 | 권위 가격 확인 | 결과 |
| --- | --- | --- |
| `unpriced` | 성공 | 계산 비용과 revision을 저장하고 `priced`로 전환 |
| `legacy` | 성공 | 기존 저장 비용을 새 계산 비용으로 교체하고 `priced`로 전환 |
| 비권위 bootstrap | 성공 | 권위 revision과 새 계산 비용으로 교체 |
| `unpriced` | 실패 | 기존 0원과 `unpriced` 유지 |
| `legacy` | 실패 | 기존 저장 비용과 `legacy` 유지 |
| authoritative `priced` | 해당 없음 | 선택하지 않고 그대로 유지 |

## 가격 이력 복구

`pricing-history`의 job 입력에서 90일 retention clamp를 제거한다. 모델별 진단의 실제 `firstAt`부터 `lastAt`까지 조직 타임존 날짜 경계로 확장하고, 기존 LiteLLM Git commit 탐색과 staged promotion을 그대로 사용한다.

가격 후보는 전체 commit과 snapshot 확인이 끝나기 전에는 canonical `pricing_revisions`에 노출하지 않는다. promotion이 완료되면 같은 transaction에서 가격 cache version과 repair generation을 갱신한다.

Git 이력에 baseline이 없거나 모델 가격이 없는 구간은 추정하지 않는다. job cursor, staging 후보와 backoff 상태를 보존하고 관리자 화면에 가격 근거 대기 상태를 표시한다.

## 저장소 계약

현재 `getUnpricedUsageModels`와 `repairUnpricedUsage`라는 이름은 실제 확장 범위를 표현하지 못한다. 저장소 공통 계약을 가격 복구 대상으로 일반화한다.

- 진단 메서드는 `unpriced`, `legacy`, 비권위 revision을 모델별·상태별로 집계한다.
- batch 메서드는 같은 선택 조건으로 canonical 이벤트를 읽는다.
- resolver 성공 시에만 update 또는 replacement version을 기록한다.
- 선택 query와 write guard는 반드시 같은 상태 조건을 사용해 경쟁 중 이미 확정된 이벤트를 덮어쓰지 않는다.
- batch 결과는 scanned, recovered unpriced, repriced legacy, reconciled, affected buckets와 hasMore를 구분한다.

구현 중 이름 변경은 저장소 구현과 worker를 한 번에 갱신한다. 외부 API로 공개된 계약이 아니므로 호환 alias는 만들지 않는다.

## PostgreSQL 처리

PostgreSQL은 한 batch를 transaction으로 처리한다.

1. 대상 행을 발생 시각 오름차순으로 `FOR UPDATE SKIP LOCKED` 선택한다.
2. resolver가 authoritative revision을 찾은 행만 갱신한다.
3. `legacy` 행은 기존 비용을 resolver 결과로 교체하고 `priced`로 바꾼다.
4. 영향을 받은 local day mart를 같은 transaction 안에서 재계산한다.
5. batch 전체가 성공하면 commit하고, 오류가 나면 rollback한다.

업데이트 조건에도 대상 상태 guard를 다시 넣어 다른 worker나 수집 경로가 먼저 확정한 행을 덮어쓰지 않는다.

## ClickHouse 처리

ClickHouse는 기존 ReplacingMergeTree 경로를 사용하고 mutation으로 원본 행을 직접 수정하지 않는다.

1. `usage_events FINAL`에서 대상 canonical 행을 제한된 batch로 읽는다.
2. resolver 성공 행의 15분 bucket을 `usage_15m_v2` dirty로 먼저 기록한다.
3. 같은 `dedup_key`에 더 높은 version의 authoritative `priced` 행을 insert한다.
4. 실패하면 dirty가 남아 조회가 exact fallback을 사용한다.
5. coordinator가 dirty 15분 bucket을 재집계한다.
6. 이어서 영향받은 시간대별 1시간·1일 bucket을 재생성하고 fingerprint 검증을 통과한 coverage만 읽는다.

replacement insert는 결정론적 generation token을 사용해 재시도 중 같은 복구를 중복 생성하지 않는다.

## Worker 진행과 공정성

가격 복구는 기존 rollup coordinator의 `pricing_repair` 작업으로 계속 실행한다. 별도 경쟁 timer를 추가하지 않는다.

- adaptive batch limit 25~500 계약을 유지한다.
- Codex replay reconciliation을 먼저 수행하는 현재 순서를 유지한다.
- replay가 끝난 뒤 전체 가격 복구 대상 진단과 batch 처리를 수행한다.
- source history 확인, event repair, rollup 재집계는 coordinator의 기존 공정성 규칙을 공유한다.
- batch가 일부만 처리되면 즉시 `pending`으로 돌아가 다음 tick에서 이어간다.
- source 근거가 없는 대상만 남으면 `waiting_for_catalog`와 backoff를 사용한다.
- process 재시작 시 `running` stale claim을 회수하는 기존 규칙을 유지한다.

## 상태와 관리자 화면

`pricing_repair_status`에 다음 누적·잔여 지표를 추가한다.

- `repriced_legacy_events`: authoritative 역사 가격으로 전환한 legacy 누적 수
- `remaining_legacy_events`: 현재 generation 상한 안에서 남은 legacy 수

기존 지표 의미는 유지한다.

- `recovered_events`: `unpriced`에서 `priced`로 복구한 수
- `reconciled_events`: Codex replay 중복 보정 수
- `remaining_unpriced_events`: 남은 unpriced 수

관리 화면은 다음을 구분해 보여준다.

- 미확정 비용 복구 완료
- 이전 가격 재계산 완료
- 남은 미확정
- 남은 이전 가격 기준
- 마지막 자동 처리 시각
- 가격 이력이 확인되지 않은 모델과 상태별 건수

상태가 `idle`이어도 `remaining_legacy_events > 0`이면 전체 완료로 표현하지 않는다. 가격 이력이 없는 대상만 남았으면 `waiting_for_catalog`로 표시한다.

## 사용자 화면과 캐시

사용자 화면의 coverage 계산과 `이전 가격 기준` 문구 조건은 변경하지 않는다. 데이터가 `priced`로 전환되고 관련 rollup이 재생성되면 기존 query의 `legacyEvents`가 감소한다.

가격 복구 generation이 완료되면 사용자 인사이트 cache를 무효화해 10분 revalidate 기간 때문에 이미 0이 된 legacy 문구가 남지 않게 한다. 진행 중인 batch마다 전체 cache를 비우지 않고, generation이 `idle` 또는 장기 `waiting_for_catalog` 상태로 전환될 때 한 번만 무효화한다.

## Migration과 기동

additive migration은 다음만 수행한다.

1. `pricing_repair_status`에 legacy 진행률 컬럼을 추가한다.
2. generation과 `target_to`를 현재 시각으로 갱신한다.
3. 상태를 `pending`으로 만들고 신규 legacy 누적·잔여 지표를 0으로 초기화한다.
4. coordinator가 다음 tick에서 실제 저장소 전체 범위를 진단하게 한다.

사용 이벤트와 ClickHouse 데이터를 migration SQL에서 직접 변경하지 않는다. 구버전 설치가 여러 migration을 한 번에 적용해도 가격 revision schema와 historical job schema가 먼저 준비된 뒤 worker가 실행된다.

## 오류와 안전성

- resolver 실패: 해당 이벤트는 변경하지 않는다.
- GitHub 장애·rate limit: job cursor와 staging을 보존하고 backoff 후 재시도한다.
- PostgreSQL batch 실패: transaction 전체 rollback.
- ClickHouse replacement 실패: dirty를 남겨 exact fallback을 유지하고 재시도한다.
- rollup 검증 실패: 잘못된 cache coverage를 승인하지 않는다.
- 경쟁 update: write guard가 이미 확정된 행을 덮어쓰지 않는다.
- 모델이나 토큰 메타데이터 누락: 기존 legacy 비용을 유지하고 관리자 unresolved 목록에 남긴다.
- 이미 `priced`로 전환된 이벤트: 다음 batch에서 선택되지 않는다.

비밀값, GitHub 인증 토큰과 사용자 이벤트 본문은 로그나 관리자 응답에 포함하지 않는다.

## 테스트 전략

### Worker 단위 테스트

- 90일 이전 legacy도 진단과 repair 대상으로 전달된다.
- legacy resolver 성공 수가 `repricedLegacyEvents`에 누적된다.
- source 근거가 없는 legacy는 비용과 상태를 보존한다.
- unpriced, legacy, 비권위 bootstrap이 섞인 batch에서 상태별 카운트가 정확하다.
- authoritative priced는 resolver 호출과 write 대상에서 제외된다.
- generation 완료 시 cache invalidation이 한 번만 실행된다.

### PostgreSQL 저장소 테스트

- 선택 SQL이 `legacy`를 포함한다.
- update guard도 같은 상태 조건을 사용한다.
- legacy 성공 행의 비용, revision, 상태가 함께 변경된다.
- resolver 실패 행과 authoritative priced 행은 변경되지 않는다.
- 영향받은 local day만 재계산한다.

### ClickHouse 저장소 테스트

- `FINAL` 선택이 legacy를 포함한다.
- replacement 행이 새 비용, revision, `priced` 상태를 가진다.
- 성공한 legacy 행의 15분 bucket만 dirty 처리한다.
- 재시도 시 결정론적 version으로 중복 canonical 결과를 만들지 않는다.
- 15분과 시간대별 rollup coverage가 dirty 동안 exact fallback을 유지한다.

### 가격 이력 테스트

- 90일보다 오래된 `firstAt`이 retention clamp 없이 job 범위에 포함된다.
- baseline과 commit pagination, staged promotion 계약은 유지된다.
- source에 가격이 없는 오래된 구간은 추정 revision을 만들지 않는다.

### 통합 검증

- PostgreSQL 16 fixture에서 legacy 전환 전후 event 수와 모든 token 합계가 동일하다.
- ClickHouse fixture에서 raw canonical, 15분, 시간대별 1시간·1일 집계의 비용·coverage가 일치한다.
- migration 적용 직후 worker가 전체 legacy generation을 자동으로 시작한다.
- 관련 테스트, 전체 typecheck, 전체 test, web production build, `git diff --check`를 통과한다.

## 완료 기준

- 저장소에 남아 있고 권위 있는 역사 가격으로 계산 가능한 legacy 이벤트 전체가 `priced`로 전환된다.
- 권위 가격 근거가 없는 legacy는 기존 비용을 잃지 않고 남는다.
- 관리자 화면에서 완료·잔여 legacy 수와 unresolved 원인을 구분할 수 있다.
- 비용 외 이벤트 데이터와 event 수가 변경되지 않는다.
- ClickHouse rollup과 exact source의 비용·coverage가 검증 후 일치한다.
- legacy가 0이 된 조회 범위의 사용자 화면에서는 `이전 가격 기준` 문구가 표시되지 않는다.
